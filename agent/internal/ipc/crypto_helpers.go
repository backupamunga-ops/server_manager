package ipc

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

func computeHMACSHA256(data string, key []byte) string {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return hex.EncodeToString(h.Sum(nil))
}
