package main

import (
	"go/build"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestMainEntryPointBuildModes(t *testing.T) {
	for _, tags := range [][]string{nil, {"server"}} {
		ctx := build.Default
		ctx.BuildTags = tags
		matched, err := ctx.MatchFile(".", "main.go")
		if err != nil || !matched {
			t.Errorf("main.go with tags %v: matched = %v, err = %v", tags, matched, err)
		}
	}
}

func TestSPAFallback(t *testing.T) {
	dist := fstest.MapFS{
		"index.html":     &fstest.MapFile{Data: []byte("index")},
		"assets/main.js": &fstest.MapFile{Data: []byte("script")},
	}
	for _, tc := range []struct {
		name, method, target, wantPath string
		rewritten                      bool
	}{
		{"root", "GET", "/", "/", true},
		{"asset", "GET", "/assets/main.js", "/assets/main.js", false},
		{"directory", "GET", "/assets", "/assets", false},
		{"deep link", "GET", "/canvas/nested?repo=one", "/", true},
		{"missing asset", "GET", "/assets/missing.js", "/", true},
		{"wails endpoint", "GET", "/wails/runtime", "/wails/runtime", false},
		{"post", "POST", "/canvas", "/canvas", false},
		{"head", "HEAD", "/canvas", "/canvas", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.target, nil)
			got := spaFallback(req, dist)
			if got.URL.Path != tc.wantPath || (got != req) != tc.rewritten {
				t.Fatalf("path = %q, rewritten = %v; want %q, %v", got.URL.Path, got != req, tc.wantPath, tc.rewritten)
			}
			if got.URL.RawQuery != req.URL.RawQuery || req.URL.Path != httptest.NewRequest(tc.method, tc.target, nil).URL.Path {
				t.Fatal("fallback changed the query or original request")
			}
			if got.Method != tc.method || got.Header == nil || got.Context() != req.Context() {
				t.Fatal("fallback did not preserve request properties")
			}
		})
	}
}
