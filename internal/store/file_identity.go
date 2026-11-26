package store

import (
	"fmt"
	"os"
	"reflect"
)

// FileIdentity returns a durable identity from the platform file metadata.
// It is empty when the platform does not expose a stable file ID. Callers
// must fail closed when they need to prove ownership across operations.
func FileIdentity(info interface{ Sys() any }) string {
	if info == nil || info.Sys() == nil {
		return ""
	}
	v := reflect.ValueOf(info.Sys())
	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return ""
		}
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return ""
	}
	read := func(names ...string) (uint64, bool) {
		for _, name := range names {
			field := v.FieldByName(name)
			if !field.IsValid() {
				continue
			}
			switch field.Kind() {
			case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
				return field.Uint(), true
			case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
				return uint64(field.Int()), true
			}
		}
		return 0, false
	}
	device, hasDevice := read("Dev", "VolumeSerialNumber", "vol")
	inode, hasInode := read("Ino", "FileIndex", "idx")
	if !hasInode {
		hi, hasHigh := read("FileIndexHigh", "idxhi")
		lo, hasLow := read("FileIndexLow", "idxlo")
		if hasHigh && hasLow {
			inode, hasInode = hi<<32|lo, true
		}
	}
	if !hasDevice || !hasInode {
		return ""
	}
	return fmt.Sprintf("%x:%x", device, inode)
}

// FileIdentityAt returns a durable identity for info using path when the OS
// does not expose the file ID through FileInfo.Sys(). The path must refer to
// the same file described by info; otherwise the function returns an empty ID.
func FileIdentityAt(path string, info os.FileInfo) string {
	if info == nil {
		return ""
	}
	if identity := platformFileIdentityAt(path, info); identity != "" {
		return identity
	}
	return FileIdentity(info)
}

func windowsFileIdentityParts(volume, fileIndexHigh, fileIndexLow uint32) string {
	index := uint64(fileIndexHigh)<<32 | uint64(fileIndexLow)
	return fmt.Sprintf("%x:%x", volume, index)
}
