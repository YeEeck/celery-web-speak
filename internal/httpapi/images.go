package httpapi

import (
	"bytes"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"

	_ "golang.org/x/image/webp"
)

const (
	imageMaxUploadBytes = 4 << 20
	imageMaxDimension   = 1024
	imageAspectEpsilon  = 0.02
	imagePNGMIME        = "image/png"
	imageJPEGMIME       = "image/jpeg"
	imageWebPMIME       = "image/webp"
)

var allowedImageMIME = map[string]bool{
	imagePNGMIME:  true,
	imageJPEGMIME: true,
	imageWebPMIME: true,
}

// validateImageHeader decodes the image header to verify dimensions and aspect
// ratio, and returns the canonical MIME derived from the decoded format rather
// than the client-supplied Content-Type so a spoofed MIME cannot bypass the
// allow-list.
func validateImageHeader(reader io.Reader) (string, error) {
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
	default:
		return "", errors.New("仅支持 PNG、JPEG、WebP")
	}
	if !allowedImageMIME[mime] {
		return "", errors.New("仅支持 PNG、JPEG、WebP")
	}
	if config.Width <= 0 || config.Height <= 0 || config.Width > imageMaxDimension || config.Height > imageMaxDimension {
		return "", errors.New("图片尺寸需为不大于 1024×1024")
	}
	aspect := float64(config.Width) / float64(config.Height)
	if aspect < 1-imageAspectEpsilon || aspect > 1+imageAspectEpsilon {
		return "", errors.New("图片必须为正方形(宽高比 1:1)")
	}
	return mime, nil
}

// readImageUpload reads a multipart image upload named "file", enforcing the
// total upload size limit and validating the decoded image header. Returns the
// canonical MIME and the raw image bytes.
func readImageUpload(w http.ResponseWriter, r *http.Request) (mime string, buf []byte, ok bool) {
	r.Body = http.MaxBytesReader(w, r.Body, imageMaxUploadBytes)
	if err := r.ParseMultipartForm(imageMaxUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, "image_too_large", "图片文件总大小不能超过 4 MB")
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
		writeError(w, http.StatusBadRequest, "image_too_large", "图片文件总大小不能超过 4 MB")
		return "", nil, false
	}
	mime, err = validateImageHeader(bytes.NewReader(buf))
	if err != nil {
		writeError(w, http.StatusBadRequest, "image_invalid", err.Error())
		return "", nil, false
	}
	return mime, buf, true
}