// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-ldap/ldap/v3"

	"github.com/cicdteam/ldap-ui/internal/ldapx"
	"github.com/cicdteam/ldap-ui/internal/session"
)

func TestErrorResponse(t *testing.T) {
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	defer srv.Close()
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
		wantReason string
	}{
		{
			name: "AD bad password", err: ldap.NewError(ldap.LDAPResultInvalidCredentials, errors.New("80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 52e, v4563")),
			wantStatus: http.StatusUnauthorized, wantCode: "invalid_credentials", wantReason: "invalid credentials",
		},
		{name: "no such object", err: ldap.NewError(ldap.LDAPResultNoSuchObject, errors.New("")), wantStatus: http.StatusNotFound, wantCode: "no_such_object"},
		{name: "access", err: ldap.NewError(ldap.LDAPResultInsufficientAccessRights, errors.New("")), wantStatus: http.StatusForbidden, wantCode: "insufficient_access"},
		{name: "filter", err: ldap.NewError(ldap.ErrorFilterCompile, errors.New("bad")), wantStatus: http.StatusBadRequest, wantCode: "bad_filter"},
		{name: "network", err: ldap.NewError(ldap.ErrorNetwork, errors.New("refused")), wantStatus: http.StatusBadGateway, wantCode: "network"},
		{
			// What ldapx returns when the server hangs up during Dial.
			name: "dropped connection", err: fmt.Errorf("read root DSE: %w", ldap.NewError(ldap.ErrorNetwork, errors.New("unable to read LDAP response packet: EOF"))),
			wantStatus: http.StatusBadGateway, wantCode: "network",
		},
		{name: "no such attribute", err: ldap.NewError(ldap.LDAPResultNoSuchAttribute, errors.New("modify/delete: mail: no such value")), wantStatus: http.StatusConflict, wantCode: "conflict"},
		{name: "constraint violation", err: ldap.NewError(ldap.LDAPResultConstraintViolation, errors.New("")), wantStatus: http.StatusUnprocessableEntity, wantCode: "rejected"},
		{
			name: "AD password policy", err: ldap.NewError(ldap.LDAPResultConstraintViolation, errors.New("0000052D: Constraint violation - check_password_restrictions: the password is too short")),
			wantStatus: http.StatusUnprocessableEntity, wantCode: "rejected", wantReason: "password does not meet the policy",
		},
		{
			name: "AD password policy, unwilling", err: ldap.NewError(ldap.LDAPResultUnwillingToPerform, errors.New("0000052D: SvcErr: DSID-031A1254, problem 5003 (WILL_NOT_PERFORM), data 0")),
			wantStatus: http.StatusBadGateway, wantCode: "ldap_error", wantReason: "password does not meet the policy",
		},
		{name: "entry exists", err: ldap.NewError(ldap.LDAPResultEntryAlreadyExists, errors.New("")), wantStatus: http.StatusConflict, wantCode: "conflict"},
		{name: "naming violation", err: ldap.NewError(ldap.LDAPResultNamingViolation, errors.New("")), wantStatus: http.StatusUnprocessableEntity, wantCode: "rejected"},
		{name: "not allowed on non-leaf", err: ldap.NewError(ldap.LDAPResultNotAllowedOnNonLeaf, errors.New("")), wantStatus: http.StatusUnprocessableEntity, wantCode: "rejected"},
		{name: "other ldap", err: ldap.NewError(ldap.LDAPResultBusy, errors.New("")), wantStatus: http.StatusBadGateway, wantCode: "ldap_error"},
		{name: "invalid request", err: fmt.Errorf("%w: bad cursor", ldapx.ErrInvalidRequest), wantStatus: http.StatusBadRequest, wantCode: "bad_request"},
		{
			name: "cursor expired with ldap error", err: fmt.Errorf("%w: %w", ldapx.ErrCursorExpired, ldap.NewError(ldap.LDAPResultUnwillingToPerform, errors.New(""))),
			wantStatus: http.StatusGone, wantCode: "cursor_expired",
		},
		{name: "timeout", err: context.DeadlineExceeded, wantStatus: http.StatusGatewayTimeout, wantCode: "timeout"},
		{name: "not connected", err: session.ErrNotConnected, wantStatus: http.StatusUnauthorized, wantCode: "not_connected"},
		{name: "no session", err: session.ErrNoSession, wantStatus: http.StatusUnauthorized, wantCode: "not_connected"},
		{name: "closed connection", err: net.ErrClosed, wantStatus: http.StatusUnauthorized, wantCode: "not_connected"},
		{
			name: "untrusted cert", err: &ldapx.UntrustedCertError{Certificates: []*x509.Certificate{srv.Certificate()}, Err: x509.UnknownAuthorityError{}},
			wantStatus: http.StatusBadGateway, wantCode: "tls_untrusted",
		},
		{name: "unknown", err: errors.New("boom"), wantStatus: http.StatusInternalServerError, wantCode: "internal"},
	}
	for _, tc := range tests {
		status, body := errorResponse(tc.err)
		if status != tc.wantStatus || body.Code != tc.wantCode || body.Reason != tc.wantReason {
			t.Errorf("%s: errorResponse() = %d %q reason %q, want %d %q reason %q", tc.name, status, body.Code, body.Reason, tc.wantStatus, tc.wantCode, tc.wantReason)
		}
	}
	_, body := errorResponse(&ldapx.UntrustedCertError{Certificates: []*x509.Certificate{srv.Certificate()}, Err: x509.UnknownAuthorityError{}})
	if len(body.Certificates) != 1 || len(body.Certificates[0].SHA256) != 64 || body.Certificates[0].PEM == "" {
		t.Errorf("errorResponse(untrusted).Certificates = %+v, want one cert with sha256 and PEM", body.Certificates)
	}
	// Internal errors may name local files; s.fail logs them instead.
	internal := errors.New("open /etc/ldapui/ca.pem: permission denied")
	if _, body := errorResponse(internal); body.Code != "internal" || strings.Contains(body.Message, "/etc/ldapui/ca.pem") {
		t.Errorf("errorResponse(%q) = %q %q, want internal without the error text", internal, body.Code, body.Message)
	}
}
