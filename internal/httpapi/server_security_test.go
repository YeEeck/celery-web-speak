package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSecurityHeadersAllowWasmWithoutJavaScriptEval(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	handler := (&Server{}).securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	handler.ServeHTTP(recorder, request)

	policy := recorder.Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "script-src 'self' 'wasm-unsafe-eval'") {
		t.Fatalf("Content-Security-Policy does not allow WebAssembly compilation: %q", policy)
	}
	if strings.Contains(policy, "'unsafe-eval'") {
		t.Fatalf("Content-Security-Policy allows JavaScript string evaluation: %q", policy)
	}
}
