package webui

import "embed"

// Files is replaced with the production Vue build during the container build.
//
//go:embed all:dist
var Files embed.FS
