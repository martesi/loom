package media

import (
	"context"
	"encoding/binary"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// SourceDimensions reads still-image dimensions from headers. AVIF uses ffprobe
// because its item-property/track-based dimension metadata needs a full ISO-BMFF
// property resolver; video and BMP/TIFF also use ffprobe. No rendition encoder
// is invoked.
func SourceDimensions(path string) (Dimensions, error) {
	return SourceDimensionsContext(context.Background(), path)
}

func SourceDimensionsContext(ctx context.Context, path string) (Dimensions, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png", ".jpg", ".jpeg", ".gif":
		file, err := os.Open(path)
		if err != nil {
			return Dimensions{}, err
		}
		defer file.Close()
		config, _, err := image.DecodeConfig(file)
		if err != nil {
			return Dimensions{}, err
		}
		return Dimensions{Width: config.Width, Height: config.Height}, nil
	case ".webp":
		return webpDimensions(path)
	default:
		return probeDimensionsContext(ctx, path)
	}
}

func webpDimensions(path string) (Dimensions, error) {
	file, err := os.Open(path)
	if err != nil {
		return Dimensions{}, err
	}
	defer file.Close()
	var riff [12]byte
	if _, err := io.ReadFull(file, riff[:]); err != nil {
		return Dimensions{}, err
	}
	if string(riff[:4]) != "RIFF" || string(riff[8:]) != "WEBP" {
		return Dimensions{}, fmt.Errorf("invalid WebP header")
	}
	for {
		var header [8]byte
		if _, err := io.ReadFull(file, header[:]); err != nil {
			return Dimensions{}, err
		}
		size := int64(binary.LittleEndian.Uint32(header[4:]))
		switch string(header[:4]) {
		case "VP8X":
			var data [10]byte
			if size < int64(len(data)) {
				return Dimensions{}, fmt.Errorf("short VP8X chunk")
			}
			if _, err := io.ReadFull(file, data[:]); err != nil {
				return Dimensions{}, err
			}
			return Dimensions{Width: 1 + int(data[4]) + int(data[5])<<8 + int(data[6])<<16, Height: 1 + int(data[7]) + int(data[8])<<8 + int(data[9])<<16}, nil
		case "VP8L":
			var data [5]byte
			if size < int64(len(data)) {
				return Dimensions{}, fmt.Errorf("short VP8L chunk")
			}
			if _, err := io.ReadFull(file, data[:]); err != nil {
				return Dimensions{}, err
			}
			if data[0] != 0x2f {
				return Dimensions{}, fmt.Errorf("invalid VP8L signature")
			}
			bits := binary.LittleEndian.Uint32(data[1:])
			return Dimensions{Width: 1 + int(bits&0x3fff), Height: 1 + int((bits>>14)&0x3fff)}, nil
		case "VP8 ":
			var data [10]byte
			if size < int64(len(data)) {
				return Dimensions{}, fmt.Errorf("short VP8 chunk")
			}
			if _, err := io.ReadFull(file, data[:]); err != nil {
				return Dimensions{}, err
			}
			if data[3] != 0x9d || data[4] != 0x01 || data[5] != 0x2a {
				return Dimensions{}, fmt.Errorf("invalid VP8 frame header")
			}
			return Dimensions{Width: int(binary.LittleEndian.Uint16(data[6:8]) & 0x3fff), Height: int(binary.LittleEndian.Uint16(data[8:10]) & 0x3fff)}, nil
		default:
			if _, err := io.CopyN(io.Discard, file, size+(size&1)); err != nil {
				return Dimensions{}, err
			}
		}
	}
}
