package nativeclipboard

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
)

func Write(paths []string) error {
	uris := make([]string, len(paths))
	for i, p := range paths {
		uris[i] = (&url.URL{Scheme: "file", Path: p}).String()
	}
	var cmd *exec.Cmd
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		cmd = exec.Command("wl-copy", "--type", "text/uri-list")
	} else {
		cmd = exec.Command("xclip", "-selection", "clipboard", "-t", "text/uri-list", "-i")
	}
	cmd.Stdin = strings.NewReader(strings.Join(uris, "\r\n"))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("native file clipboard: %w: %s", err, out)
	}
	return nil
}
func Read() ([]string, error) {
	var cmd *exec.Cmd
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		cmd = exec.Command("wl-paste", "--no-newline", "--type", "text/uri-list")
	} else {
		cmd = exec.Command("xclip", "-selection", "clipboard", "-t", "text/uri-list", "-o")
	}
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("read native file clipboard: %w", err)
	}
	paths := []string{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		u, err := url.Parse(line)
		if err != nil || u.Scheme != "file" || (u.Host != "" && u.Host != "localhost") {
			return nil, fmt.Errorf("clipboard contains a non-local file URI")
		}
		paths = append(paths, u.Path)
	}
	return paths, nil
}
