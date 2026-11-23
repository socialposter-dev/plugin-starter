// Reference SocialPoster 1.0.0 WebAssembly plugin in Go (TinyGo + Extism Go PDK).
//
// Compile with:
//   GOFLAGS="-buildvcs=false" tinygo build -o ../output/example-social-go.wasm -target wasip1 -buildmode=c-shared -no-debug .
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	pdk "github.com/extism/go-pdk"
)

// ---------------------------------------------------------------------------
// SocialPoster 1.0.0 Host Functions (extism:host/user)
// ---------------------------------------------------------------------------

//go:wasmimport extism:host/user sp_credential
func spCredential(keyPtr uint64) uint64

//go:wasmimport extism:host/user sp_media_chunk
func spMediaChunk(reqPtr uint64) uint64

//go:wasmimport extism:host/user sp_http
func spHttp(reqPtr uint64) uint64

// ---------------------------------------------------------------------------
// ABI Data Structures
// ---------------------------------------------------------------------------

type AuthorLink struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

type Author struct {
	Name  string       `json:"name"`
	Links []AuthorLink `json:"links"`
}

type CredentialField struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Secret   bool   `json:"secret"`
	Required bool   `json:"required"`
}

type AuthMode struct {
	ID                string            `json:"id"`
	Label             string            `json:"label"`
	Description       string            `json:"description"`
	SetupInstructions string            `json:"setup_instructions"`
	Fields            []CredentialField `json:"fields"`
}

type DescribeOutput struct {
	ID                   string     `json:"id"`
	Version              string     `json:"version"`
	CompatibleAppVersion string     `json:"compatible_app_version"`
	DisplayName          string     `json:"display_name"`
	Authors              []Author   `json:"authors"`
	BrandColour          string     `json:"brand_colour"`
	IconSVG              string     `json:"icon_svg"`
	MaxCharacters        int        `json:"max_characters"`
	MaxAttachments       int        `json:"max_attachments"`
	SupportedMediaTypes  []string   `json:"supported_media_types"`
	SupportsAltText      bool       `json:"supports_alt_text"`
	SupportsThreads      bool       `json:"supports_threads"`
	SupportsDelete       bool       `json:"supports_delete"`
	AllowedDomains       []string   `json:"allowed_domains"`
	AuthModes            []AuthMode `json:"auth_modes"`
}

type ValidateAuthOutput struct {
	Valid bool   `json:"valid"`
	Error string `json:"error,omitempty"`
}

type Attachment struct {
	AttachmentID string `json:"attachment_id"`
	MimeType     string `json:"mime_type"`
	Filename     string `json:"filename"`
	SizeBytes    int    `json:"size_bytes"`
	AltText      string `json:"alt_text,omitempty"`
}

type PublishInput struct {
	Text        string       `json:"text"`
	Attachments []Attachment `json:"attachments"`
	ReplyToID   string       `json:"reply_to_id,omitempty"`
}

type PublishOutput struct {
	PostID string `json:"post_id"`
	URL    string `json:"url"`
}

type DeletePostInput struct {
	PostID string `json:"post_id"`
}

type DeletePostOutput struct {
	Deleted bool `json:"deleted"`
}

type SpHttpResponse struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func readCredential(key string) string {
	keyMem := pdk.AllocateString(key)
	defer keyMem.Free()

	ptr := spCredential(keyMem.Offset())
	if ptr == 0 {
		return ""
	}
	mem := pdk.FindMemory(ptr)
	defer mem.Free()
	return mem.ReadString()
}

func activeAuthMode() string {
	mode := strings.TrimSpace(readCredential("__auth_mode"))
	if mode == "" {
		return "api_key"
	}
	return mode
}

func modeTokenKey(mode string) string {
	if mode == "webhook_app" {
		return "app_token"
	}
	return "api_token"
}

func resolveBaseURL() string {
	trimmed := strings.TrimRight(strings.TrimSpace(readCredential("instance_url")), "/")
	if trimmed != "" {
		return trimmed
	}
	return "https://api.example.com"
}

func callSpHttp(method, url string, headers map[string]string, body string) (SpHttpResponse, error) {
	payload := map[string]any{
		"method":  method,
		"url":     url,
		"headers": headers,
	}
	if body != "" {
		payload["body"] = body
	}
	reqBytes, err := json.Marshal(payload)
	if err != nil {
		return SpHttpResponse{}, err
	}
	reqMem := pdk.AllocateBytes(reqBytes)
	defer reqMem.Free()

	resPtr := spHttp(reqMem.Offset())
	if resPtr == 0 {
		return SpHttpResponse{}, errors.New("sp_http returned null memory offset")
	}
	resMem := pdk.FindMemory(resPtr)
	defer resMem.Free()

	var resp SpHttpResponse
	if err := json.Unmarshal(resMem.ReadBytes(), &resp); err != nil {
		return SpHttpResponse{}, err
	}
	return resp, nil
}

func streamAttachmentBytes(att Attachment) ([]byte, error) {
	const chunkSize = 65536
	var out []byte
	offset := 0

	for {
		reqBytes, _ := json.Marshal(map[string]any{
			"attachment_id": att.AttachmentID,
			"offset":        offset,
			"length":        chunkSize,
		})
		reqMem := pdk.AllocateBytes(reqBytes)
		chunkPtr := spMediaChunk(reqMem.Offset())
		reqMem.Free()

		if chunkPtr == 0 {
			break
		}
		chunkMem := pdk.FindMemory(chunkPtr)
		chunk := chunkMem.ReadBytes()
		chunkMem.Free()

		if len(chunk) == 0 {
			break
		}
		out = append(out, chunk...)
		offset += len(chunk)
		if len(chunk) < chunkSize {
			break
		}
	}
	return out, nil
}

func outputJSON(v any) int32 {
	data, err := json.Marshal(v)
	if err != nil {
		pdk.SetError(fmt.Errorf("failed to serialise response: %v", err))
		return 1
	}
	pdk.Output(data)
	return 0
}

// ---------------------------------------------------------------------------
// Required SocialPoster 1.0.0 ABI Exports
// ---------------------------------------------------------------------------

//go:wasmexport describe
func describe() int32 {
	meta := DescribeOutput{
		ID:                   "example-social",
		Version:              "1.0.0",
		CompatibleAppVersion: "^1.0.0",
		DisplayName:          "Example Social",
		Authors: []Author{
			{
				Name: "Your Name",
				Links: []AuthorLink{
					{Label: "Website", URL: "https://example.com"},
				},
			},
		},
		BrandColour:         "#5B4BFF",
		IconSVG:             `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 12l3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
		MaxCharacters:       500,
		MaxAttachments:      4,
		SupportedMediaTypes: []string{"image/jpeg", "image/png", "image/webp", "video/mp4"},
		SupportsAltText:     true,
		SupportsThreads:     true,
		SupportsDelete:      true,
		AllowedDomains:      []string{"api.example.com", "upload.example.com"},
		AuthModes: []AuthMode{
			{
				ID:                "api_key",
				Label:             "API Key",
				Description:       "Authenticate using a personal API token and account handle.",
				SetupInstructions: "1. Open **Settings -> Developer** on Example Social.\n2. Create a new **API Token** with publish and delete permissions.\n3. Paste your token and account handle below.",
				Fields: []CredentialField{
					{Key: "api_token", Label: "API Token", Secret: true, Required: true},
					{Key: "handle", Label: "Account Handle", Secret: false, Required: true},
					{Key: "instance_url", Label: "Instance URL", Secret: false, Required: false},
				},
			},
			{
				ID:                "webhook_app",
				Label:             "App Credentials",
				Description:       "Authenticate using an application token and optional webhook signing secret.",
				SetupInstructions: "1. Register an application in the **Example Social App Portal**.\n2. Copy the **App Token** and optional **Webhook Signing Secret**.",
				Fields: []CredentialField{
					{Key: "app_token", Label: "App Token", Secret: true, Required: true},
					{Key: "webhook_secret", Label: "Webhook Signing Secret", Secret: true, Required: false},
				},
			},
		},
	}
	return outputJSON(meta)
}

//go:wasmexport validate_auth
func validateAuth() int32 {
	mode := activeAuthMode()
	token := strings.TrimSpace(readCredential(modeTokenKey(mode)))
	if token == "" {
		return outputJSON(ValidateAuthOutput{
			Valid: false,
			Error: fmt.Sprintf("Missing required token for authentication mode '%s'.", mode),
		})
	}
	if mode == "api_key" && strings.TrimSpace(readCredential("handle")) == "" {
		return outputJSON(ValidateAuthOutput{
			Valid: false,
			Error: "Account Handle is required for API Key mode.",
		})
	}

	url := resolveBaseURL() + "/v1/accounts/verify_credentials"
	res, err := callSpHttp("GET", url, map[string]string{
		"Authorization": "Bearer " + token,
		"Accept":        "application/json",
	}, "")
	if err != nil {
		pdk.SetError(err)
		return 1
	}

	if res.Status >= 200 && res.Status < 300 {
		return outputJSON(ValidateAuthOutput{Valid: true})
	}

	return outputJSON(ValidateAuthOutput{
		Valid: false,
		Error: fmt.Sprintf("Authorisation failed with HTTP status %d.", res.Status),
	})
}

//go:wasmexport publish
func publish() int32 {
	var input PublishInput
	if err := pdk.InputJSON(&input); err != nil {
		pdk.SetError(fmt.Errorf("invalid input JSON: %v", err))
		return 1
	}

	mode := activeAuthMode()
	token := strings.TrimSpace(readCredential(modeTokenKey(mode)))
	if token == "" {
		pdk.SetError(fmt.Errorf("Missing required credential for mode '%s'.", mode))
		return 1
	}
	baseURL := resolveBaseURL()

	// 1. Stream media attachments via `sp_media_chunk` and upload via `sp_http`.
	mediaIDs := make([]string, 0, len(input.Attachments))
	for _, att := range input.Attachments {
		rawBytes, err := streamAttachmentBytes(att)
		if err != nil {
			pdk.SetError(err)
			return 1
		}
		uploadBody, _ := json.Marshal(map[string]any{
			"filename":    att.Filename,
			"mime_type":   att.MimeType,
			"byte_length": len(rawBytes),
			"alt_text":    att.AltText,
		})
		uploadRes, err := callSpHttp("POST", "https://upload.example.com/v1/media", map[string]string{
			"Authorization": "Bearer " + token,
			"Content-Type":  "application/json",
		}, string(uploadBody))
		if err != nil {
			pdk.SetError(err)
			return 1
		}
		if uploadRes.Status < 200 || uploadRes.Status >= 300 {
			pdk.SetError(fmt.Errorf("Media upload failed with HTTP status %d.", uploadRes.Status))
			return 1
		}

		var uploaded struct {
			MediaID string `json:"media_id"`
		}
		if err := json.Unmarshal([]byte(uploadRes.Body), &uploaded); err == nil && uploaded.MediaID != "" {
			mediaIDs = append(mediaIDs, uploaded.MediaID)
		}
	}

	// 2. Publish the post via `sp_http`, including optional `reply_to_id` for threads.
	postPayload := map[string]any{
		"text":      input.Text,
		"media_ids": mediaIDs,
	}
	if input.ReplyToID != "" {
		postPayload["reply_to_id"] = input.ReplyToID
	}

	postBody, _ := json.Marshal(postPayload)
	postRes, err := callSpHttp("POST", baseURL+"/v1/posts", map[string]string{
		"Authorization": "Bearer " + token,
		"Content-Type":  "application/json",
	}, string(postBody))
	if err != nil {
		pdk.SetError(err)
		return 1
	}
	if postRes.Status < 200 || postRes.Status >= 300 {
		pdk.SetError(fmt.Errorf("Publish failed with HTTP status %d.", postRes.Status))
		return 1
	}

	var created struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	}
	_ = json.Unmarshal([]byte(postRes.Body), &created)
	if created.ID == "" {
		created.ID = "post_unknown"
	}
	if created.URL == "" {
		created.URL = baseURL + "/posts/" + created.ID
	}

	// Prefix `post_id` with `<mode>:` so `delete_post` routes correctly even if modes change.
	return outputJSON(PublishOutput{
		PostID: mode + ":" + created.ID,
		URL:    created.URL,
	})
}

//go:wasmexport delete_post
func deletePost() int32 {
	var input DeletePostInput
	if err := pdk.InputJSON(&input); err != nil {
		pdk.SetError(fmt.Errorf("invalid input JSON: %v", err))
		return 1
	}

	trimmed := strings.TrimSpace(input.PostID)
	if trimmed == "" {
		pdk.SetError(errors.New("post_id must not be empty."))
		return 1
	}

	mode := activeAuthMode()
	rawID := trimmed
	if idx := strings.IndexByte(trimmed, ':'); idx > 0 && idx+1 < len(trimmed) {
		mode = trimmed[:idx]
		rawID = trimmed[idx+1:]
	}

	token := strings.TrimSpace(readCredential(modeTokenKey(mode)))
	if token == "" {
		pdk.SetError(fmt.Errorf("Missing required credential for mode '%s'.", mode))
		return 1
	}

	url := fmt.Sprintf("%s/v1/posts/%s", resolveBaseURL(), rawID)
	res, err := callSpHttp("DELETE", url, map[string]string{
		"Authorization": "Bearer " + token,
	}, "")
	if err != nil {
		pdk.SetError(err)
		return 1
	}
	if res.Status < 200 || res.Status >= 300 {
		pdk.SetError(fmt.Errorf("Delete failed with HTTP status %d.", res.Status))
		return 1
	}

	return outputJSON(DeletePostOutput{Deleted: true})
}

func main() {}
