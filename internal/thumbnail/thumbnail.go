// Package thumbnail generates small AVIF preview images for canvas nodes,
// shelling out to ffmpeg/ffprobe.
package thumbnail

import (
	"bytes"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// Generate produces a small AVIF thumbnail for srcPath at destPath, and
// returns the source's pixel dimensions (discovered as a side effect of
// probing, so callers get them without a second pass). For video files, the
// thumbnail is the frame at the clip's midpoint.
func Generate(srcPath, destPath string, isVideo bool) (width, height int, err error) {
	width, height, err = probeDimensions(srcPath)
	if err != nil {
		return 0, 0, fmt.Errorf("probe dimensions: %w", err)
	}

	args := []string{"-y"}
	if isVideo {
		mid, err := probeMidpoint(srcPath)
		if err != nil {
			return 0, 0, fmt.Errorf("probe duration: %w", err)
		}
		args = append(args, "-ss", fmt.Sprintf("%.3f", mid))
	}
	args = append(args,
		"-i", srcPath,
		"-vf", "scale=320:-2:force_original_aspect_ratio=decrease",
		"-frames:v", "1",
		"-c:v", "libaom-av1",
		"-crf", "32",
		"-b:v", "0",
		"-still-picture", "1",
		destPath,
	)

	cmd := exec.Command("ffmpeg", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return 0, 0, fmt.Errorf("ffmpeg: %w: %s", err, stderr.String())
	}
	return width, height, nil
}

func probeDimensions(path string) (int, int, error) {
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path).Output()
	if err != nil {
		return 0, 0, err
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "x", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("unexpected ffprobe output: %q", out)
	}
	w, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, err
	}
	h, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, err
	}
	return w, h, nil
}

func probeMidpoint(path string) (float64, error) {
	out, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration",
		"-of", "csv=p=0", path).Output()
	if err != nil {
		return 0, err
	}
	d, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil {
		return 0, err
	}
	return d / 2, nil
}
