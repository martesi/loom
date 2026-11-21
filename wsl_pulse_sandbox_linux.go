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
	"os"
	"strings"
	"unsafe"
)

// registerWSLgPulseSocketInWebKitSandbox exposes only WSLg's PulseAudio
// socket. WebKit's sandbox cannot mount the scheme-prefixed address, and it
// does not find WSLg's socket through the runtime-directory fallback.
func registerWSLgPulseSocketInWebKitSandbox() {
	path := os.Getenv("PULSE_SERVER")
	if !strings.HasPrefix(path, "/mnt/wslg/") {
		return
	}

	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))
	C.add_pulse_socket_to_sandbox(cPath)
}
