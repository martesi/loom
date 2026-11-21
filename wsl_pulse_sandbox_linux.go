//go:build linux && !server

package main

/*
#cgo pkg-config: webkitgtk-6.0
#include <stdlib.h>
#include <webkit/webkit.h>

static void add_pulse_socket_to_sandbox(const char *path) {
	WebKitWebContext *context = webkit_web_context_get_default();
	if (context != NULL)
		webkit_web_context_add_path_to_sandbox(context, path, TRUE);
}
*/
import "C"

import (
	"fmt"
	"os"
	"strings"
	"unsafe"
)

// configureWSLgPulseSandbox converts WSLg's Unix socket address to its raw
// path and exposes only that socket to WebKit's sandbox. WebKitGTK's bwrap
// launcher aborts on the scheme-prefixed path, while its runtime-directory
// fallback does not expose WSLg's symlinked socket inside the sandbox.
func configureWSLgPulseSandbox() error {
	path := os.Getenv("PULSE_SERVER")
	if strings.HasPrefix(path, "unix:/mnt/wslg/") {
		path = strings.TrimPrefix(path, "unix:")
		if err := os.Setenv("PULSE_SERVER", path); err != nil {
			return fmt.Errorf("set WSLg PulseAudio socket path: %w", err)
		}
	}
	if !strings.HasPrefix(path, "/mnt/wslg/") {
		return nil
	}

	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))
	C.add_pulse_socket_to_sandbox(cPath)
	return nil
}
