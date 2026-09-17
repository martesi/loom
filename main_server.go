//go:build server

package main

import (
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func main() {
	if err := application.New(appOptions()).Run(); err != nil {
		log.Fatal(err)
	}
}
