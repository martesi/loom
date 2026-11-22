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
		if strings.EqualFold(filepath.Ext(path), ".jpg") || strings.EqualFold(filepath.Ext(path), ".jpeg") {
			orientation, _ := jpegEXIFOrientation(path)
			if orientation >= 5 && orientation <= 8 {
				config.Width, config.Height = config.Height, config.Width
			}
		}
		return Dimensions{Width: config.Width, Height: config.Height}, nil
	case ".webp":
		return webpDimensions(path)
	default:
		return probeDimensionsContext(ctx, path)
	}
}

func jpegEXIFOrientation(path string) (int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	var signature [2]byte
	if _, err := io.ReadFull(file, signature[:]); err != nil || signature != [2]byte{0xff, 0xd8} {
		return 0, fmt.Errorf("invalid JPEG signature")
	}
	for {
		var markerPrefix byte
		for markerPrefix != 0xff {
			if err := binary.Read(file, binary.BigEndian, &markerPrefix); err != nil {
				return 0, err
			}
		}
		var marker byte
		for {
			if err := binary.Read(file, binary.BigEndian, &marker); err != nil {
				return 0, err
			}
			if marker != 0xff {
				break
			}
		}
		if marker == 0xda || marker == 0xd9 {
			return 1, nil
		}
		var length uint16
		if err := binary.Read(file, binary.BigEndian, &length); err != nil {
			return 0, err
		}
		if length < 2 {
			return 0, fmt.Errorf("invalid JPEG segment size")
		}
		segment := make([]byte, int(length)-2)
		if _, err := io.ReadFull(file, segment); err != nil {
			return 0, err
		}
		if marker == 0xe1 && len(segment) >= 6 && string(segment[:6]) == "Exif\x00\x00" {
			return parseTIFFOrientation(segment[6:])
		}
	}
}

func parseTIFFOrientation(data []byte) (int, error) {
	if len(data) < 8 {
		return 0, fmt.Errorf("short EXIF TIFF header")
	}
	var order binary.ByteOrder
	switch string(data[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0, fmt.Errorf("invalid EXIF byte order")
	}
	if order.Uint16(data[2:4]) != 42 {
		return 0, fmt.Errorf("invalid EXIF TIFF marker")
	}
	offset := uint64(order.Uint32(data[4:8]))
	if offset+2 > uint64(len(data)) {
		return 0, fmt.Errorf("invalid EXIF IFD offset")
	}
	count := uint64(order.Uint16(data[offset:]))
	entries := offset + 2
	if entries+count*12 > uint64(len(data)) {
		return 0, fmt.Errorf("truncated EXIF IFD")
	}
	for i := uint64(0); i < count; i++ {
		entry := data[entries+i*12 : entries+(i+1)*12]
		if order.Uint16(entry[:2]) == 0x0112 && order.Uint16(entry[2:4]) == 3 && order.Uint32(entry[4:8]) == 1 {
			orientation := int(order.Uint16(entry[8:10]))
			if orientation >= 1 && orientation <= 8 {
				return orientation, nil
			}
			return 0, fmt.Errorf("invalid EXIF orientation")
		}
	}
	return 1, nil
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
