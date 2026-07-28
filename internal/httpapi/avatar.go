package httpapi

import (
	"bytes"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"strconv"

	_ "golang.org/x/image/webp"
)

const (
	avatarMaxUploadBytes = 4 << 20
	avatarMaxDimension   = 1024
	avatarAspectEpsilon  = 0.02
	avatarPNGMIME        = "image/png"
	avatarJPEGMIME       = "image/jpeg"
	avatarWebPMIME       = "image/webp"
)

var allowedAvatarMIME = map[string]bool{
	avatarPNGMIME:  true,
	avatarJPEGMIME: true,
	avatarWebPMIME: true,
}

func (s *Server) handleUploadMyAvatar(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, avatarMaxUploadBytes)
	if err := r.ParseMultipartForm(avatarMaxUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, "avatar_too_large", "头像文件总大小不能超过 4 MB")
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "avatar_missing", "未找到上传的图片")
		return
	}
	defer file.Close()
	buf, err := io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusBadRequest, "avatar_read_failed", "读取头像失败")
		return
	}
	if int64(len(buf)) > avatarMaxUploadBytes {
		writeError(w, http.StatusBadRequest, "avatar_too_large", "头像文件总大小不能超过 4 MB")
		return
	}
	mime, err := validateAvatarHeader(bytes.NewReader(buf))
	if err != nil {
		writeError(w, http.StatusBadRequest, "avatar_invalid", err.Error())
		return
	}
	user, err := s.store.SetAvatar(r.Context(), currentUser(r).ID, mime, buf)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastUser(user.ID, "user_updated", user)
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) handleDeleteMyAvatar(w http.ResponseWriter, r *http.Request) {
	user, err := s.store.ClearAvatar(r.Context(), currentUser(r).ID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastUser(user.ID, "user_updated", user)
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) handleGetUserAvatar(w http.ResponseWriter, r *http.Request) {
	id, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
	version, mime, avatarBytes, hasAvatar, err := s.store.GetAvatar(r.Context(), id)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if !hasAvatar || len(avatarBytes) == 0 {
		writeError(w, http.StatusNotFound, "avatar_not_found", "用户未设置头像")
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", strconv.FormatInt(int64(version), 10))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(avatarBytes)
}

func (s *Server) handleAdminDeleteAvatar(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
	if targetID == currentUser(r).ID {
		writeError(w, http.StatusBadRequest, "avatar_admin_self", "不能在管理接口清除自己的头像")
		return
	}
	user, err := s.store.ClearAvatar(r.Context(), targetID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastUser(user.ID, "user_updated", user)
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

// validateAvatarHeader decodes the image header to verify dimensions and aspect
// ratio, and returns the canonical MIME derived from the decoded format rather
// than the client-supplied Content-Type so a spoofed MIME cannot bypass the
// allow-list.
func validateAvatarHeader(reader io.Reader) (string, error) {
	config, format, err := image.DecodeConfig(reader)
	if err != nil {
		return "", errors.New("图片格式不可识别或已损坏")
	}
	var mime string
	switch format {
	case "png":
		mime = avatarPNGMIME
	case "jpeg":
		mime = avatarJPEGMIME
	case "webp":
		mime = avatarWebPMIME
	default:
		return "", errors.New("仅支持 PNG、JPEG、WebP")
	}
	if !allowedAvatarMIME[mime] {
		return "", errors.New("仅支持 PNG、JPEG、WebP")
	}
	if config.Width <= 0 || config.Height <= 0 || config.Width > avatarMaxDimension || config.Height > avatarMaxDimension {
		return "", errors.New("图片尺寸需为不大于 1024×1024")
	}
	aspect := float64(config.Width) / float64(config.Height)
	if aspect < 1-avatarAspectEpsilon || aspect > 1+avatarAspectEpsilon {
		return "", errors.New("头像必须为正方形(宽高比 1:1)")
	}
	return mime, nil
}