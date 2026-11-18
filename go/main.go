// Reference SocialPoster WebAssembly plugin in Go (TinyGo + Extism Go PDK).
//
// Compile with:
//   tinygo build -o ../output/example-social-go.wasm -target wasip1 -buildmode=c-shared .
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	pdk "github.com/extism/go-pdk"
)

// ---------------------------------------------------------------------------
// ABI Data Structures
// ---------------------------------------------------------------------------

type CredentialField struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Secret   bool   `json:"secret"`
	Required bool   `json:"required"`
}

type DescribeOutput struct {
	ID                  string            `json:"id"`
	Version             string            `json:"version"`
	DisplayName         string            `json:"display_name"`
	BrandColour         string            `json:"brand_colour"`
	IconSVG             string            `json:"icon_svg"`
	MaxCharacters       int               `json:"max_characters"`
	MaxAttachments      int               `json:"max_attachments"`
	SupportedMediaTypes []string          `json:"supported_media_types"`
	SupportsAltText     bool              `json:"supports_alt_text"`
	SupportsThreads     bool              `json:"supports_threads"`
	SupportsDelete      bool              `json:"supports_delete"`
	AllowedDomains      []string          `json:"allowed_domains"`
	CredentialFields    []CredentialField `json:"credential_fields"`
}

type ValidateAuthInput struct {
	Credentials map[string]string `json:"credentials"`
}

type ValidateAuthOutput struct {
	Valid bool   `json:"valid"`
	Error string `json:"error,omitempty"`
}

type Attachment struct {
	DataBase64 string `json:"data_base64"`
	MimeType   string `json:"mime_type"`
	Filename   string `json:"filename"`
	AltText    string `json:"alt_text,omitempty"`
}

type PublishInput struct {
	Credentials map[string]string `json:"credentials"`
	Text        string            `json:"text"`
	Attachments []Attachment      `json:"attachments"`
	ReplyToID   string            `json:"reply_to_id,omitempty"`
}

type PublishOutput struct {
	PostID string `json:"post_id"`
	URL    string `json:"url"`
}

type DeletePostInput struct {
	Credentials map[string]string `json:"credentials"`
	PostID      string            `json:"post_id"`
}

type DeletePostOutput struct {
	Deleted bool `json:"deleted"`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func resolveBaseURL(creds map[string]string) string {
	if raw, ok := creds["instance_url"]; ok {
		trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
		if trimmed != "" {
			return trimmed
		}
	}
	return "https://api.example.com"
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
// Required SocialPoster ABI Exports
// ---------------------------------------------------------------------------

//go:wasmexport describe
func describe() int32 {
	meta := DescribeOutput{
		ID:                  "example-social",
		Version:             "1.0.0",
		DisplayName:         "Example Social",
		BrandColour:         "#5B4BFF",
		IconSVG:             `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 12l3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
		MaxCharacters:       500,
		MaxAttachments:      4,
		SupportedMediaTypes: []string{"image/jpeg", "image/png", "image/webp", "video/mp4"},
		SupportsAltText:     true,
		SupportsThreads:     true,
		SupportsDelete:      true,
		AllowedDomains:      []string{"api.example.com", "upload.example.com"},
		CredentialFields: []CredentialField{
			// 1. Required secret
			{Key: "api_token", Label: "API Token", Secret: true, Required: true},
			// 2. Required plain text
			{Key: "handle", Label: "Account Handle", Secret: false, Required: true},
			// 3. Optional plain text
			{Key: "instance_url", Label: "Instance URL", Secret: false, Required: false},
			// 4. Optional secret
			{Key: "webhook_secret", Label: "Webhook Signing Secret", Secret: true, Required: false},
		},
	}
	return outputJSON(meta)
}

//go:wasmexport validate_auth
func validateAuth() int32 {
	var input ValidateAuthInput
	if err := pdk.InputJSON(&input); err != nil {
		pdk.SetError(fmt.Errorf("invalid input JSON: %v", err))
		return 1
	}

	token := strings.TrimSpace(input.Credentials["api_token"])
	handle := strings.TrimSpace(input.Credentials["handle"])
	if token == "" || handle == "" {
		return outputJSON(ValidateAuthOutput{
			Valid: false,
			Error: "Both api_token and handle are required.",
		})
	}

	url := resolveBaseURL(input.Credentials) + "/v1/accounts/verify_credentials"
	req := pdk.NewHTTPRequest(pdk.MethodGet, url)
	req.SetHeader("Authorization", "Bearer "+token)
	req.SetHeader("Accept", "application/json")

	res := req.Send()
	if res.Status() >= 200 && res.Status() < 300 {
		return outputJSON(ValidateAuthOutput{Valid: true})
	}

	return outputJSON(ValidateAuthOutput{
		Valid: false,
		Error: fmt.Sprintf("Authorisation failed with HTTP status %d.", res.Status()),
	})
}

//go:wasmexport publish
func publish() int32 {
	var input PublishInput
	if err := pdk.InputJSON(&input); err != nil {
		pdk.SetError(fmt.Errorf("invalid input JSON: %v", err))
		return 1
	}

	token := input.Credentials["api_token"]
	if token == "" {
		pdk.SetError(errors.New("Missing required credential: api_token"))
		return 1
	}
	baseURL := resolveBaseURL(input.Credentials)

	// 1. Upload media attachments (preserving alt_text) to upload.example.com.
	mediaIDs := make([]string, 0, len(input.Attachments))
	for _, att := range input.Attachments {
		uploadBody, _ := json.Marshal(map[string]any{
			"filename":    att.Filename,
			"mime_type":   att.MimeType,
			"data_base64": att.DataBase64,
			"alt_text":    att.AltText,
		})
		uploadReq := pdk.NewHTTPRequest(pdk.MethodPost, "https://upload.example.com/v1/media")
		uploadReq.SetHeader("Authorization", "Bearer "+token)
		uploadReq.SetHeader("Content-Type", "application/json")
		uploadReq.SetBody(uploadBody)

		uploadRes := uploadReq.Send()
		if uploadRes.Status() < 200 || uploadRes.Status() >= 300 {
			pdk.SetError(fmt.Errorf("Media upload failed with HTTP status %d.", uploadRes.Status()))
			return 1
		}

		var uploaded struct {
			MediaID string `json:"media_id"`
		}
		if err := json.Unmarshal(uploadRes.Body(), &uploaded); err == nil && uploaded.MediaID != "" {
			mediaIDs = append(mediaIDs, uploaded.MediaID)
		}
	}

	// 2. Publish the post, including optional reply_to_id for threads.
	postPayload := map[string]any{
		"text":      input.Text,
		"media_ids": mediaIDs,
	}
	if input.ReplyToID != "" {
		postPayload["reply_to_id"] = input.ReplyToID
	}

	postBody, _ := json.Marshal(postPayload)
	postReq := pdk.NewHTTPRequest(pdk.MethodPost, baseURL+"/v1/posts")
	postReq.SetHeader("Authorization", "Bearer "+token)
	postReq.SetHeader("Content-Type", "application/json")
	postReq.SetBody(postBody)

	postRes := postReq.Send()
	if postRes.Status() < 200 || postRes.Status() >= 300 {
		pdk.SetError(fmt.Errorf("Publish failed with HTTP status %d.", postRes.Status()))
		return 1
	}

	var created struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	}
	_ = json.Unmarshal(postRes.Body(), &created)
	if created.ID == "" {
		created.ID = "post_unknown"
	}
	if created.URL == "" {
		created.URL = baseURL + "/posts/" + created.ID
	}

	return outputJSON(PublishOutput{
		PostID: created.ID,
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

	token := input.Credentials["api_token"]
	if token == "" {
		pdk.SetError(errors.New("Missing required credential: api_token"))
		return 1
	}
	if strings.TrimSpace(input.PostID) == "" {
		pdk.SetError(errors.New("post_id must not be empty."))
		return 1
	}

	url := fmt.Sprintf("%s/v1/posts/%s", resolveBaseURL(input.Credentials), input.PostID)
	req := pdk.NewHTTPRequest(pdk.MethodDelete, url)
	req.SetHeader("Authorization", "Bearer "+token)

	res := req.Send()
	if res.Status() < 200 || res.Status() >= 300 {
		pdk.SetError(fmt.Errorf("Delete failed with HTTP status %d.", res.Status()))
		return 1
	}

	return outputJSON(DeletePostOutput{Deleted: true})
}

func main() {}
