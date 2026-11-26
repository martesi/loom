package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"

	"loom/internal/store"
)

const admissionDiscoverCanvas = "discover_canvas"
const admissionCreateRepository = "create_repository"
const admissionMigrateRepository = "migrate_repository"

var errAdmissionUnknownOperation = errors.New("admission operation is not supported by this profile")
var errAdmissionRepositoryExists = errors.New("repository database already exists")
var errAdmissionRepositoryMissing = errors.New("repository database does not exist")
var errAdmissionNoPendingMigrations = errors.New("repository has no pending migrations")
var errAdmissionMigrationRequired = errors.New("repository migration must be admitted before discovery")

// AdmissionFacade is a narrow Wails surface for the integration profile. It
// is intentionally not part of the default production service registration.
type AdmissionFacade struct {
	registry   *admissionRegistry
	images     *ImageService
	operations map[string]admissionOperation
}

type admissionOperation func(canonicalRoot string, payload []byte) admissionOutcome

type AdmissionTicket struct {
	Root          string `json:"root"`
	OperationID   string `json:"operationId"`
	Epoch         uint64 `json:"epoch"`
	Kind          string `json:"kind"`
	PayloadDigest string `json:"payloadDigest"`
}

type AdmissionStatus struct {
	State            string   `json:"state"`
	Epoch            uint64   `json:"epoch"`
	Kind             string   `json:"kind"`
	PayloadDigest    string   `json:"payloadDigest"`
	Result           string   `json:"result"`
	ErrorMessage     string   `json:"errorMessage"`
	PartialResults   []string `json:"partialResults"`
	RecoveryRequired bool     `json:"recoveryRequired"`
	Drained          bool     `json:"drained"`
	DrainError       string   `json:"drainError"`
}

type AdmissionResult struct {
	Result           string   `json:"result"`
	ErrorMessage     string   `json:"errorMessage"`
	PartialResults   []string `json:"partialResults"`
	RecoveryRequired bool     `json:"recoveryRequired"`
}

type discoverCanvasPayload struct {
	Action string `json:"action"`
}

func newAdmissionFacade(registry *admissionRegistry) *AdmissionFacade {
	facade := &AdmissionFacade{registry: registry, images: &ImageService{}}
	facade.operations = map[string]admissionOperation{
		admissionCreateRepository:  func(root string, _ []byte) admissionOutcome { return facade.createRepository(root) },
		admissionMigrateRepository: func(root string, _ []byte) admissionOutcome { return facade.migrateRepository(root) },
		admissionDiscoverCanvas:    func(root string, _ []byte) admissionOutcome { return facade.discoverCanvas(root) },
		admissionSetGeometry:       facade.setGeometry,
		admissionSetPositions:      facade.setPositions,
		admissionSetViewport:       facade.setViewport,
		admissionPlaceImages:       facade.placeImages,
		admissionUnplaceImages:     facade.unplaceImages,
	}
	return facade
}

func (facade *AdmissionFacade) Reserve(root, operationID, kind string, payload []byte) (AdmissionTicket, error) {
	if facade.registry == nil {
		return AdmissionTicket{}, errAdmissionDrainUnavailable
	}
	if _, ok := facade.operations[kind]; !ok {
		return AdmissionTicket{}, errAdmissionUnknownOperation
	}
	if err := validateAdmissionPayload(kind, payload); err != nil {
		return AdmissionTicket{}, err
	}
	if err := facade.validateOperationPrecondition(root, kind); err != nil {
		return AdmissionTicket{}, err
	}
	token, err := facade.registry.Reserve(root, operationID, kind, payload)
	if err != nil {
		return AdmissionTicket{}, err
	}
	return ticketFromAdmissionToken(token), nil
}

func (facade *AdmissionFacade) Dispatch(ticket AdmissionTicket, payload []byte) (AdmissionResult, error) {
	token, err := ticket.admissionToken()
	if err != nil {
		return AdmissionResult{}, err
	}
	operation, ok := facade.operations[token.kind]
	if !ok {
		return AdmissionResult{}, errAdmissionUnknownOperation
	}
	if err := validateAdmissionPayload(token.kind, payload); err != nil {
		return AdmissionResult{}, err
	}
	outcome, err := facade.registry.Dispatch(token, payload, func() admissionOutcome { return operation(token.root, payload) })
	if err != nil {
		return AdmissionResult{}, err
	}
	return admissionResultFromOutcome(outcome), nil
}

func (facade *AdmissionFacade) createRepository(root string) admissionOutcome {
	unlock := store.LockRepoOperations(root)
	defer unlock()
	status, err := store.InspectRepositoryMigrations(root)
	if err != nil {
		return admissionFailure(err)
	}
	if status.DatabaseExists {
		return admissionOutcome{errorMessage: errAdmissionRepositoryExists.Error()}
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		return admissionFailure(err)
	}
	if err := repo.Close(); err != nil {
		return admissionFailure(err)
	}
	return admissionOutcome{result: []byte("created")}
}

func (facade *AdmissionFacade) migrateRepository(root string) admissionOutcome {
	unlock := store.LockRepoOperations(root)
	defer unlock()
	status, err := store.InspectRepositoryMigrations(root)
	if err != nil {
		return admissionFailure(err)
	}
	if !status.DatabaseExists {
		return admissionOutcome{errorMessage: errAdmissionRepositoryMissing.Error()}
	}
	if len(status.Pending) == 0 {
		return admissionOutcome{errorMessage: errAdmissionNoPendingMigrations.Error()}
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		return admissionFailure(err)
	}
	if err := repo.Close(); err != nil {
		return admissionFailure(err)
	}
	return admissionOutcome{result: []byte("migrated")}
}

func (facade *AdmissionFacade) discoverCanvas(root string) admissionOutcome {
	if err := facade.images.discoverCanvasExisting(root); err != nil {
		return admissionFailure(err)
	}
	return admissionOutcome{result: []byte("discovered")}
}

func (facade *AdmissionFacade) ObserveCanvas(root string) (*CanvasObservation, error) {
	return (&ImageService{}).ObserveCanvas(root)
}

func (facade *AdmissionFacade) InspectRepository(root string) (store.MigrationInspection, error) {
	return store.InspectRepositoryMigrations(root)
}

func (facade *AdmissionFacade) Status(root, operationID string) (AdmissionStatus, error) {
	status, err := facade.registry.Status(root, operationID)
	if err != nil {
		return AdmissionStatus{}, err
	}
	return AdmissionStatus{
		State: string(status.state), Epoch: status.epoch, Kind: status.kind,
		PayloadDigest: hex.EncodeToString(status.digest[:]),
		Result:        string(status.outcome.result), ErrorMessage: status.outcome.errorMessage,
		PartialResults:   append([]string(nil), status.outcome.partialResults...),
		RecoveryRequired: status.recoveryRequired, Drained: status.drained,
		DrainError: status.drainError,
	}, nil
}

func (facade *AdmissionFacade) Seal(ticket AdmissionTicket) error {
	token, err := ticket.admissionToken()
	if err != nil {
		return err
	}
	if err := facade.registry.ValidateToken(token); err != nil {
		return err
	}
	return facade.registry.SealIfNotStarted(token.root, token.id)
}

// SealUnclaimed supports the lost-reserve-response case after reload. It only
// tombstones an operation ID that has not started; a claimed operation cannot
// be sealed through this recovery endpoint.
func (facade *AdmissionFacade) SealUnclaimed(root, operationID string) error {
	return facade.registry.SealIfNotStarted(root, operationID)
}

func (facade *AdmissionFacade) Reconcile(ticket AdmissionTicket) error {
	token, err := ticket.admissionToken()
	if err != nil {
		return err
	}
	if err := facade.registry.ValidateToken(token); err != nil {
		return err
	}
	return facade.registry.CloseAfterReconciliation(token, func(admissionOutcome) error {
		_, err := facade.ObserveCanvas(token.root)
		return err
	})
}

func (facade *AdmissionFacade) validateOperationPrecondition(root, kind string) error {
	status, err := store.InspectRepositoryMigrations(root)
	if err != nil {
		return err
	}
	switch kind {
	case admissionCreateRepository:
		if status.DatabaseExists {
			return errAdmissionRepositoryExists
		}
	case admissionMigrateRepository:
		if !status.DatabaseExists {
			return errAdmissionRepositoryMissing
		}
		if len(status.Pending) == 0 {
			return errAdmissionNoPendingMigrations
		}
	case admissionDiscoverCanvas, admissionSetGeometry, admissionSetPositions, admissionSetViewport, admissionPlaceImages, admissionUnplaceImages:
		if !status.DatabaseExists {
			return errAdmissionRepositoryMissing
		}
		if len(status.Pending) != 0 {
			return errAdmissionMigrationRequired
		}
	default:
		return errAdmissionUnknownOperation
	}
	return nil
}

func (ticket AdmissionTicket) admissionToken() (admissionToken, error) {
	root, err := store.CanonicalRepoOperationRoot(ticket.Root)
	if err != nil || root != ticket.Root || ticket.OperationID == "" || ticket.Kind == "" {
		return admissionToken{}, errAdmissionInvalid
	}
	digest, err := hex.DecodeString(ticket.PayloadDigest)
	if err != nil || len(digest) != sha256.Size {
		return admissionToken{}, errAdmissionInvalid
	}
	var token admissionToken
	token.root, token.id, token.epoch, token.kind = root, ticket.OperationID, ticket.Epoch, ticket.Kind
	copy(token.digest[:], digest)
	return token, nil
}

func ticketFromAdmissionToken(token admissionToken) AdmissionTicket {
	return AdmissionTicket{
		Root: token.root, OperationID: token.id, Epoch: token.epoch, Kind: token.kind,
		PayloadDigest: hex.EncodeToString(token.digest[:]),
	}
}

func admissionResultFromOutcome(outcome admissionOutcome) AdmissionResult {
	return AdmissionResult{
		Result: string(outcome.result), ErrorMessage: outcome.errorMessage,
		PartialResults:   append([]string(nil), outcome.partialResults...),
		RecoveryRequired: outcome.recoveryRequired,
	}
}

func admissionFailure(err error) admissionOutcome {
	return admissionOutcome{errorMessage: err.Error(), recoveryRequired: true}
}

func validateAdmissionPayload(kind string, payload []byte) error {
	switch kind {
	case admissionSetGeometry, admissionSetPositions, admissionSetViewport, admissionPlaceImages, admissionUnplaceImages:
		return (&AdmissionFacade{}).validateCanvasPayload(kind, payload)
	}
	var request discoverCanvasPayload
	if err := decodeStrictAdmissionJSON(payload, &request); err != nil || request.Action != kind {
		return errAdmissionInvalid
	}
	return nil
}

func decodeStrictAdmissionJSON(raw []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errAdmissionInvalid
	}
	return nil
}
