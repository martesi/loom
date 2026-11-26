package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

const (
	admissionSetGeometry   = "set_geometry"
	admissionSetPositions  = "set_positions"
	admissionSetViewport   = "set_viewport"
	admissionPlaceImages   = "place_images"
	admissionUnplaceImages = "unplace_images"
)

type admissionCanvasPayload struct {
	Action   string           `json:"action"`
	Geometry []GeometryUpdate `json:"geometry,omitempty"`
	Position []PositionUpdate `json:"positions,omitempty"`
	Viewport *Viewport        `json:"viewport,omitempty"`
	IDs      []int64          `json:"ids,omitempty"`
	X        float64          `json:"x,omitempty"`
	Y        float64          `json:"y,omitempty"`
	GroupID  int64            `json:"groupId,omitempty"`
}

func (facade *AdmissionFacade) setGeometry(root string, raw []byte) admissionOutcome {
	request, err := decodeAdmissionCanvasPayload(raw)
	if err != nil {
		return admissionFailure(err)
	}
	if err := facade.images.SetGeometry(root, request.Geometry); err != nil {
		return admissionFailure(err)
	}
	return admissionOutcome{result: []byte("updated")}
}

func (facade *AdmissionFacade) setPositions(root string, raw []byte) admissionOutcome {
	request, err := decodeAdmissionCanvasPayload(raw)
	if err != nil {
		return admissionFailure(err)
	}
	if err := facade.images.SetPositions(root, request.Position); err != nil {
		return admissionFailure(err)
	}
	return admissionOutcome{result: []byte("updated")}
}

func (facade *AdmissionFacade) setViewport(root string, raw []byte) admissionOutcome {
	request, err := decodeAdmissionCanvasPayload(raw)
	if err != nil {
		return admissionFailure(err)
	}
	if request.Viewport == nil {
		return admissionFailure(errAdmissionInvalid)
	}
	if err := facade.images.SetViewport(root, *request.Viewport); err != nil {
		return admissionFailure(err)
	}
	return admissionOutcome{result: []byte("updated")}
}

func (facade *AdmissionFacade) placeImages(root string, raw []byte) admissionOutcome {
	request, err := decodeAdmissionCanvasPayload(raw)
	if err != nil {
		return admissionFailure(err)
	}
	if err := facade.images.PlaceImages(root, request.IDs, request.X, request.Y, request.GroupID); err != nil {
		return admissionFailure(err)
	}
	return admissionOutcome{result: []byte("placed")}
}

func (facade *AdmissionFacade) unplaceImages(root string, raw []byte) admissionOutcome {
	request, err := decodeAdmissionCanvasPayload(raw)
	if err != nil {
		return admissionFailure(err)
	}
	if err := facade.images.UnplaceImages(root, request.IDs); err != nil {
		return admissionFailure(err)
	}
	return admissionOutcome{result: []byte("unplaced")}
}

func decodeAdmissionCanvasPayload(raw []byte) (admissionCanvasPayload, error) {
	var request admissionCanvasPayload
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return admissionCanvasPayload{}, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return admissionCanvasPayload{}, errAdmissionInvalid
	}
	return request, nil
}

func validateCanvasAdmissionPayload(kind string, request admissionCanvasPayload) error {
	if request.Action != kind {
		return errAdmissionInvalid
	}
	switch kind {
	case admissionSetGeometry:
		if len(request.Geometry) == 0 || request.Position != nil || request.Viewport != nil || request.IDs != nil {
			return errAdmissionInvalid
		}
	case admissionSetPositions:
		if len(request.Position) == 0 || request.Geometry != nil || request.Viewport != nil || request.IDs != nil {
			return errAdmissionInvalid
		}
	case admissionSetViewport:
		if request.Viewport == nil || request.Geometry != nil || request.Position != nil || request.IDs != nil {
			return errAdmissionInvalid
		}
	case admissionPlaceImages, admissionUnplaceImages:
		if len(request.IDs) == 0 || request.Geometry != nil || request.Position != nil || request.Viewport != nil {
			return errAdmissionInvalid
		}
		if kind == admissionUnplaceImages && (request.X != 0 || request.Y != 0 || request.GroupID != 0) {
			return errAdmissionInvalid
		}
	default:
		return fmt.Errorf("%w: %s", errAdmissionUnknownOperation, kind)
	}
	return nil
}

func (facade *AdmissionFacade) validateCanvasPayload(kind string, raw []byte) error {
	var request admissionCanvasPayload
	if err := decodeStrictAdmissionJSON(raw, &request); err != nil {
		return err
	}
	return validateCanvasAdmissionPayload(kind, request)
}
