package media

import (
	"bytes"
	"context"
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

type TranscodeOptions struct {
	Quality   int
	MaxWidth  int
	MaxHeight int
}

type Processor interface {
	Thumbnail(srcPath, destPath string, isVideo bool) (Dimensions, error)
	Preview(ctx context.Context, srcPath, destPath string, maxWidth int, isVideo bool) error
	Transcode(srcPath, destPath string, options TranscodeOptions) error
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

func (FFmpegProcessor) Preview(ctx context.Context, srcPath, destPath string, maxWidth int, isVideo bool) error {
	if maxWidth != 640 && maxWidth != 1280 && maxWidth != 2048 {
		return fmt.Errorf("unsupported preview width %d", maxWidth)
	}
	args := []string{"-y"}
	if isVideo {
		midpoint, err := probeMidpointContext(ctx, srcPath)
		if err != nil {
			return fmt.Errorf("probe duration: %w", err)
		}
		args = append(args, "-ss", fmt.Sprintf("%.3f", midpoint))
	}
	args = append(args, "-i", srcPath, "-vf", fmt.Sprintf("scale='min(iw,%d)':'min(ih,4096)':force_original_aspect_ratio=decrease", maxWidth),
		"-frames:v", "1", "-c:v", "libwebp", "-quality", "70", destPath)
	return runFFmpegContext(ctx, args...)
}

func (FFmpegProcessor) Transcode(srcPath, destPath string, options TranscodeOptions) error {
	args := []string{"-y", "-i", srcPath, "-map_metadata", "0"}
	if filter := scaleFilter(options.MaxWidth, options.MaxHeight); filter != "" {
		args = append(args, "-vf", filter)
	}
	quality := options.Quality
	if quality <= 0 {
		quality = 60
	}
	if quality > 100 {
		quality = 100
	}
	switch strings.ToLower(filepath.Ext(destPath)) {
	case ".avif":
		crf := 63 - quality*63/100
		args = append(args,
			"-frames:v", "1",
			"-c:v", "libaom-av1",
			"-crf", strconv.Itoa(crf),
			"-b:v", "0",
			"-still-picture", "1",
		)
	case ".webp":
		args = append(args, "-frames:v", "1", "-quality", strconv.Itoa(quality))
	case ".jpg", ".jpeg":
		qscale := 31 - quality*29/100
		args = append(args, "-frames:v", "1", "-q:v", strconv.Itoa(qscale))
	case ".png":
		args = append(args, "-frames:v", "1", "-compression_level", "9")
	}
	args = append(args, destPath)
	return runFFmpeg(args...)
}

func scaleFilter(maxWidth, maxHeight int) string {
	switch {
	case maxWidth > 0 && maxHeight > 0:
		return fmt.Sprintf("scale='min(iw,%d)':'min(ih,%d)':force_original_aspect_ratio=decrease", maxWidth, maxHeight)
	case maxWidth > 0:
		return fmt.Sprintf("scale='min(iw,%d)':-2", maxWidth)
	case maxHeight > 0:
		return fmt.Sprintf("scale=-2:'min(ih,%d)'", maxHeight)
	default:
		return ""
	}
}

func runFFmpeg(args ...string) error {
	return runFFmpegContext(context.Background(), args...)
}

func runFFmpegContext(ctx context.Context, args ...string) error {
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
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
	// ffprobe joins csv fields with the separator and can emit a trailing
	// one when the stream carries side data (e.g. EXIF: "2560x1440x"), so
	// trim it before splitting or the height parse fails.
	line := strings.TrimSpace(string(out))
	parts := strings.SplitN(strings.TrimSuffix(line, "x"), "x", 2)
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
	return probeMidpointContext(context.Background(), path)
}

func probeMidpointContext(ctx context.Context, path string) (float64, error) {
	out, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration",
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
