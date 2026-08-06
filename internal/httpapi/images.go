package httpapi

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"

	_ "golang.org/x/image/webp"
)

const (
	imageMaxUploadBytes = 8 << 20
	imageMaxDimension   = 1024
	imageAspectEpsilon  = 0.02
	imagePNGMIME        = "image/png"
	imageJPEGMIME       = "image/jpeg"
	imageWebPMIME       = "image/webp"
	imageGIFMIME        = "image/gif"
)

// imagePolicy bundles a caller's allowed MIME set with the display name used in
// rejection messages, so the two travel together and cannot drift.
type imagePolicy struct {
	allowed map[string]bool
	display string
}

// avatarImagePolicy allows GIF on top of the base set — the client uploads GIF
// avatars raw (the cropper would flatten animation), so the square aspect
// contract that the cropper used to guarantee no longer applies to GIF.
var avatarImagePolicy = imagePolicy{
	allowed: map[string]bool{
		imagePNGMIME:  true,
		imageJPEGMIME: true,
		imageWebPMIME: true,
		imageGIFMIME:  true,
	},
	display: "PNG、JPEG、WebP、GIF",
}

var guildIconImagePolicy = imagePolicy{
	allowed: map[string]bool{
		imagePNGMIME:  true,
		imageJPEGMIME: true,
		imageWebPMIME: true,
	},
	display: "PNG、JPEG、WebP",
}

// validateImageHeader decodes the image header to verify dimensions and aspect
// ratio, and returns the canonical MIME derived from the decoded format rather
// than the client-supplied Content-Type so a spoofed MIME cannot bypass the
// allow-list. The aspect requirement is per-format: GIF is exempt (raw uploads
// bypass the client cropper), everything else must be 1:1.
func validateImageHeader(reader io.Reader, policy imagePolicy) (string, error) {
	config, format, err := image.DecodeConfig(reader)
	if err != nil {
		return "", errors.New("图片格式不可识别或已损坏")
	}
	var mime string
	switch format {
	case "png":
		mime = imagePNGMIME
	case "jpeg":
		mime = imageJPEGMIME
	case "webp":
		mime = imageWebPMIME
	case "gif":
		mime = imageGIFMIME
	default:
		return "", fmt.Errorf("仅支持 %s", policy.display)
	}
	if !policy.allowed[mime] {
		return "", fmt.Errorf("仅支持 %s", policy.display)
	}
	if config.Width <= 0 || config.Height <= 0 || config.Width > imageMaxDimension || config.Height > imageMaxDimension {
		return "", errors.New("图片尺寸需为不大于 1024×1024")
	}
	if mime != imageGIFMIME {
		aspect := float64(config.Width) / float64(config.Height)
		if aspect < 1-imageAspectEpsilon || aspect > 1+imageAspectEpsilon {
			return "", errors.New("图片必须为正方形(宽高比 1:1)")
		}
	}
	return mime, nil
}

// readImageUpload reads a multipart image upload named "file", enforcing the
// total upload size limit and validating the decoded image header against the
// caller's image policy. Returns the canonical MIME and the raw image bytes.
func readImageUpload(w http.ResponseWriter, r *http.Request, policy imagePolicy) (mime string, buf []byte, ok bool) {
	r.Body = http.MaxBytesReader(w, r.Body, imageMaxUploadBytes)
	if err := r.ParseMultipartForm(imageMaxUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, "image_too_large", "图片文件总大小不能超过 8 MB")
		return "", nil, false
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "image_missing", "未找到上传的图片")
		return "", nil, false
	}
	defer file.Close()
	buf, err = io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusBadRequest, "image_read_failed", "读取图片失败")
		return "", nil, false
	}
	if int64(len(buf)) > imageMaxUploadBytes {
		writeError(w, http.StatusBadRequest, "image_too_large", "图片文件总大小不能超过 8 MB")
		return "", nil, false
	}
	mime, err = validateImageHeader(bytes.NewReader(buf), policy)
	if err != nil {
		writeError(w, http.StatusBadRequest, "image_invalid", err.Error())
		return "", nil, false
	}
	return mime, buf, true
}