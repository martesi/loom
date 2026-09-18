package media

import (
	"bytes"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type Dimensions struct {
	Width  int
	Height int
}

type Processor interface {
	Thumbnail(srcPath, destPath string, isVideo bool) (Dimensions, error)
	Transcode(srcPath, destPath string) error
}

type FFmpegProcessor struct{}

func (FFmpegProcessor) Thumbnail(srcPath, destPath string, isVideo bool) (Dimensions, error) {
	dimensions, err := probeDimensions(srcPath)
	if err != nil {
		return Dimensions{}, fmt.Errorf("probe dimensions: %w", err)
	}

	args := []string{"-y"}
	if isVideo {
		midpoint, err := probeMidpoint(srcPath)
		if err != nil {
			return Dimensions{}, fmt.Errorf("probe duration: %w", err)
		}
		args = append(args, "-ss", fmt.Sprintf("%.3f", midpoint))
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
	if err := runFFmpeg(args...); err != nil {
		return Dimensions{}, err
	}
	return dimensions, nil
}

func (FFmpegProcessor) Transcode(srcPath, destPath string) error {
	args := []string{"-y", "-i", srcPath, "-map_metadata", "0"}
	if strings.EqualFold(filepath.Ext(destPath), ".avif") {
		args = append(args,
			"-frames:v", "1",
			"-c:v", "libaom-av1",
			"-crf", "30",
			"-b:v", "0",
			"-still-picture", "1",
		)
	}
	args = append(args, destPath)
	return runFFmpeg(args...)
}

func runFFmpeg(args ...string) error {
	cmd := exec.Command("ffmpeg", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg: %w: %s", err, stderr.String())
	}
	return nil
}

func probeDimensions(path string) (Dimensions, error) {
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path).Output()
	if err != nil {
		return Dimensions{}, err
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "x", 2)
	if len(parts) != 2 {
		return Dimensions{}, fmt.Errorf("unexpected ffprobe output: %q", out)
	}
	width, err := strconv.Atoi(parts[0])
	if err != nil {
		return Dimensions{}, err
	}
	height, err := strconv.Atoi(parts[1])
	if err != nil {
		return Dimensions{}, err
	}
	return Dimensions{Width: width, Height: height}, nil
}

func probeMidpoint(path string) (float64, error) {
	out, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration",
		"-of", "csv=p=0", path).Output()
	if err != nil {
		return 0, err
	}
	duration, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil {
		return 0, err
	}
	return duration / 2, nil
}
