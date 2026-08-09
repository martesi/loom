//go:build server

package main

import (
	"log"
	"os"
	"strconv"

	"github.com/wailsapp/wails/v3/pkg/application"

	"loom/internal/webauth"
)

func main() {
	gate, err := webauth.NewGate()
	if err != nil {
		log.Fatalf("loom-server: %v", err)
	}

	opts := appOptions(gate.Middleware)
	opts.Server = application.ServerOptions{
		Host: serverHost(),
		Port: serverPort(),
	}

	log.Printf("Open http://%s:%d/?token=%s to log in", loginHost(opts.Server.Host), opts.Server.Port, gate.Token())

	if err := application.New(opts).Run(); err != nil {
		log.Fatal(err)
	}
}

// serverHost mirrors the WAILS_SERVER_HOST resolution Wails itself applies
// in server mode (see pkg/application/application_server.go), but defaults
// to all interfaces rather than localhost — server mode exists precisely to
// be reachable over a network, unlike the native desktop entrypoint.
func serverHost() string {
	if host := os.Getenv("WAILS_SERVER_HOST"); host != "" {
		return host
	}
	return "0.0.0.0"
}

// serverPort mirrors Wails' own WAILS_SERVER_PORT resolution.
func serverPort() int {
	if raw := os.Getenv("WAILS_SERVER_PORT"); raw != "" {
		if port, err := strconv.Atoi(raw); err == nil {
			return port
		}
	}
	return 8080
}

// loginHost turns a listen address into something a browser can navigate
// to; "0.0.0.0" (bind-to-all-interfaces) isn't a valid destination itself.
func loginHost(host string) string {
	if host == "0.0.0.0" || host == "" {
		return "localhost"
	}
	return host
}
