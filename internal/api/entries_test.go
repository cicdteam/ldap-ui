// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/go-ldap/ldap/v3"
	"github.com/google/go-cmp/cmp"

	"github.com/cicdteam/ldap-ui/internal/ldapx"
)

const (
	addBody    = `{"dn":"uid=n,dc=example,dc=org","attributes":[{"name":"objectClass","values":["inetOrgPerson"]},{"name":"uid","values":["n"]},{"name":"description","values":["secret-value"]}]}`
	deleteBody = `{"dn":"uid=n,dc=example,dc=org"}`
	renameBody = `{"dn":"uid=n,dc=example,dc=org","newRDN":"uid=m","newParent":"ou=x,dc=example,dc=org","keepOldRDN":true}`
	// setBody's password is the value the logs must never show.
	setBody = `{"dn":"uid=n,dc=example,dc=org","password":"secret-value","method":"ssha"}`
)

// withConfirm adds the prod confirmation to a JSON object body.
func withConfirm(body, name string) string {
	return strings.Replace(body, "{", `{"confirm":"`+name+`",`, 1)
}

func TestWriteEntries(t *testing.T) {
	tests := []struct {
		name      string
		path      string
		body      string
		wantDN    string
		wantWrite string
		wantLog   string
	}{
		{
			name: "add", path: "entries/add", body: addBody, wantDN: "uid=n,dc=example,dc=org",
			wantWrite: "add uid=n,dc=example,dc=org [objectClass uid description]",
			wantLog:   `msg=added profile=dev dn="uid=n,dc=example,dc=org" attributes=3`,
		},
		{
			name: "delete", path: "entries/delete", body: deleteBody, wantDN: "uid=n,dc=example,dc=org",
			wantWrite: "delete uid=n,dc=example,dc=org",
			wantLog:   `msg=deleted profile=dev dn="uid=n,dc=example,dc=org"`,
		},
		{
			name: "move", path: "entries/rename", body: renameBody, wantDN: "uid=m,ou=x,dc=example,dc=org",
			wantWrite: "rename uid=n,dc=example,dc=org uid=m ou=x,dc=example,dc=org deleteOld=false",
			wantLog:   `msg=renamed profile=dev dn="uid=n,dc=example,dc=org" newDN="uid=m,ou=x,dc=example,dc=org"`,
		},
		{
			// Without newParent the new DN keeps the old parent as the client spelled it.
			name: "rename in place", path: "entries/rename", body: `{"dn":"cn=Doe\\, John,ou=x,dc=example,dc=org","newRDN":" cn=Doe "}`,
			wantDN:    "cn=Doe,ou=x,dc=example,dc=org",
			wantWrite: `rename cn=Doe\, John,ou=x,dc=example,dc=org cn=Doe  deleteOld=true`,
			wantLog:   `msg=renamed profile=dev dn="cn=Doe\\, John,ou=x,dc=example,dc=org" newDN="cn=Doe,ou=x,dc=example,dc=org"`,
		},
		{
			name: "password", path: "entries/password", body: setBody, wantDN: "uid=n,dc=example,dc=org",
			wantWrite: "password uid=n,dc=example,dc=org ssha",
			wantLog:   `msg="password set" profile=dev dn="uid=n,dc=example,dc=org" method=ssha`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			env := newTestEnvWith(t, Options{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
			connectTo(t, env, `{"profile":"dev"}`)
			rec := env.do(t, http.MethodPost, "/api/c/dev/"+tc.path, tc.body)
			if rec.Code != http.StatusOK {
				t.Fatalf("%s = %d %s, want 200", tc.path, rec.Code, rec.Body)
			}
			var got writeResult
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got.DN != tc.wantDN {
				t.Errorf("%s result = %s (%v), want dn %q", tc.path, rec.Body, err, tc.wantDN)
			}
			if diff := cmp.Diff([]string{tc.wantWrite}, env.dir.writes); diff != "" {
				t.Errorf("writes (-want +got):\n%s", diff)
			}
			if !strings.Contains(logs.String(), tc.wantLog) {
				t.Errorf("log lacks %q:\n%s", tc.wantLog, logs.String())
			}
			if strings.Contains(logs.String(), "secret-value") {
				t.Errorf("log contains attribute values:\n%s", logs.String())
			}
		})
	}
}

func TestWriteEntriesGuard(t *testing.T) {
	bodies := map[string]string{"entries/add": addBody, "entries/delete": deleteBody, "entries/rename": renameBody, "entries/password": setBody}
	for path, body := range bodies {
		tests := []struct {
			name       string
			connect    string
			conn       string
			body       string
			wantStatus int
			wantCode   string
		}{
			{name: "read-only", connect: `{"profile":"manual","password":"x"}`, conn: "manual", body: body, wantStatus: http.StatusForbidden, wantCode: "read_only"},
			// The profile is refused before the body is read.
			{name: "read-only with a bad body", connect: `{"profile":"manual","password":"x"}`, conn: "manual", body: `{"x":1}`, wantStatus: http.StatusForbidden, wantCode: "read_only"},
			{name: "prod without confirm", connect: `{"profile":"prodrw"}`, conn: "prodrw", body: body, wantStatus: http.StatusConflict, wantCode: "confirmation_required"},
			{name: "prod with another name", connect: `{"profile":"prodrw"}`, conn: "prodrw", body: withConfirm(body, "dev"), wantStatus: http.StatusConflict, wantCode: "confirmation_required"},
			// An invalid request is refused before the confirmation is asked for.
			{name: "prod with an invalid body", connect: `{"profile":"prodrw"}`, conn: "prodrw", body: `{"dn":""}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request"},
			{name: "prod with confirm", connect: `{"profile":"prodrw"}`, conn: "prodrw", body: withConfirm(body, "prodrw"), wantStatus: http.StatusOK},
		}
		for _, tc := range tests {
			t.Run(path+": "+tc.name, func(t *testing.T) {
				env := newTestEnv(t)
				connectTo(t, env, tc.connect)
				rec := env.do(t, http.MethodPost, "/api/c/"+tc.conn+"/"+path, tc.body)
				if rec.Code != tc.wantStatus {
					t.Fatalf("%s = %d %s, want %d", path, rec.Code, rec.Body, tc.wantStatus)
				}
				if tc.wantStatus == http.StatusOK {
					if len(env.dir.writes) != 1 {
						t.Errorf("writes = %v, want one", env.dir.writes)
					}
					return
				}
				if code := errorCode(t, rec); code != tc.wantCode {
					t.Errorf("%s code = %q, want %q", path, code, tc.wantCode)
				}
				if len(env.dir.writes) != 0 {
					t.Errorf("writes = %v, want none", env.dir.writes)
				}
			})
		}
	}
}

func TestWriteEntriesBadRequest(t *testing.T) {
	const oc = `{"name":"objectClass","values":["top"]}`
	tests := []struct {
		name     string
		path     string
		body     string
		wantAttr string
	}{
		{name: "add: empty dn", path: "entries/add", body: `{"dn":" ","attributes":[` + oc + `]}`},
		{name: "add: no attributes", path: "entries/add", body: `{"dn":"uid=n,dc=x","attributes":[]}`},
		{name: "add: no objectClass", path: "entries/add", body: `{"dn":"uid=n,dc=x","attributes":[{"name":"cn","values":["x"]}]}`},
		{name: "add: attribute without a name", path: "entries/add", body: `{"dn":"uid=n,dc=x","attributes":[` + oc + `,{"name":"","values":["x"]}]}`},
		{name: "add: no values", path: "entries/add", body: `{"dn":"uid=n,dc=x","attributes":[` + oc + `,{"name":"cn","values":[]}]}`, wantAttr: "cn"},
		{name: "add: empty value", path: "entries/add", body: `{"dn":"uid=n,dc=x","attributes":[` + oc + `,{"name":"cn","values":[""]}]}`, wantAttr: "cn"},
		{name: "add: secret", path: "entries/add", body: `{"dn":"uid=n,dc=x","attributes":[` + oc + `,{"name":"userPassword","values":["x"]}]}`, wantAttr: "userPassword"},
		{name: "add: repeated attribute", path: "entries/add", body: `{"dn":"uid=n,dc=x","attributes":[` + oc + `,{"name":"cn","values":["a"]},{"name":"CN","values":["b"]}]}`, wantAttr: "CN"},
		{name: "add: not base64", path: "entries/add", body: `{"dn":"uid=n,dc=x","attributes":[` + oc + `,{"name":"jpegPhoto","base64":true,"values":["not base64!"]}]}`, wantAttr: "jpegPhoto"},
		{name: "add: value over 1 MiB", path: "entries/add", body: `{"dn":"uid=n,dc=x","attributes":[` + oc + `,{"name":"jpegPhoto","base64":true,"values":["` + base64.StdEncoding.EncodeToString(make([]byte, ldapx.MaxValue+1)) + `"]}]}`, wantAttr: "jpegPhoto"},
		{name: "add: unknown field", path: "entries/add", body: `{"dn":"uid=n,dc=x","attributes":[` + oc + `],"x":1}`},
		// The DN is logged, so a secret in its RDN would be too.
		{name: "add: secret in the RDN", path: "entries/add", body: `{"dn":"cn=n+userPassword=hunter2,dc=x","attributes":[` + oc + `]}`, wantAttr: "userPassword"},
		{name: "add: not a DN", path: "entries/add", body: `{"dn":"hunter2","attributes":[` + oc + `]}`},
		{name: "delete: empty dn", path: "entries/delete", body: `{"dn":""}`},
		{name: "rename: empty dn", path: "entries/rename", body: `{"dn":"","newRDN":"uid=m"}`},
		{name: "rename: empty newRDN", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":" "}`},
		{name: "rename: newRDN without =", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"m"}`},
		{name: "rename: newRDN of two RDNs", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"uid=m,ou=y"}`},
		{name: "rename: parent is the entry", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"uid=m","newParent":"UID=N , dc=x"}`},
		{name: "rename: parent below the entry", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"uid=m","newParent":"ou=y,uid=n,DC=x"}`},
		{name: "rename: parent not a DN", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"uid=m","newParent":"nope"}`},
		{name: "rename: same DN", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"uid=n"}`},
		{name: "rename: same DN through the parent", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"uid=n","newParent":"dc=x"}`},
		// modrdn would add the value to the entry and the new DN to the log.
		{name: "rename: secret RDN", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"userPassword=hunter2"}`, wantAttr: "userPassword"},
		{name: "rename: secret RDN by OID", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"cn=n+2.5.4.35=hunter2"}`, wantAttr: "2.5.4.35"},
		{name: "add: secret RDN with the LDAPv2 OID. prefix", path: "entries/add", body: `{"dn":"oid.2.5.4.35=hunter2,dc=x","attributes":[` + oc + `]}`, wantAttr: "oid.2.5.4.35"},
		{name: "rename: secret RDN with the LDAPv2 OID. prefix", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"OID.2.5.4.35=hunter2"}`, wantAttr: "OID.2.5.4.35"},
		{name: "password: empty dn", path: "entries/password", body: `{"dn":"","password":"hunter2","method":"ssha"}`},
		{name: "password: not a DN", path: "entries/password", body: `{"dn":"nope","password":"hunter2","method":"ssha"}`},
		{name: "password: empty", path: "entries/password", body: `{"dn":"uid=n,dc=x","password":"","method":"ssha"}`},
		// 7 + 253 x 2 = 513 bytes, though only 260 characters.
		{name: "password: over 512 bytes", path: "entries/password", body: `{"dn":"uid=n,dc=x","password":"hunter2` + strings.Repeat("é", 253) + `","method":"ssha"}`},
		{name: "password: unknown method", path: "entries/password", body: `{"dn":"uid=n,dc=x","password":"hunter2","method":"plain"}`},
		{name: "password: no method", path: "entries/password", body: `{"dn":"uid=n,dc=x","password":"hunter2"}`},
		{name: "password: Password Modify the server lacks", path: "entries/password", body: `{"dn":"uid=n,dc=x","password":"hunter2","method":"server"}`},
		{name: "password: unknown field", path: "entries/password", body: `{"dn":"uid=n,dc=x","password":"hunter2","method":"ssha","x":1}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			env := newTestEnvWith(t, Options{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
			connectTo(t, env, `{"profile":"dev"}`)
			rec := env.do(t, http.MethodPost, "/api/c/dev/"+tc.path, tc.body)
			var e apiError
			_ = json.Unmarshal(rec.Body.Bytes(), &e)
			if rec.Code != http.StatusBadRequest || e.Code != "bad_request" || e.Attribute != tc.wantAttr {
				t.Errorf("%s = %d %+v, want 400 bad_request attribute %q", tc.path, rec.Code, e, tc.wantAttr)
			}
			if len(env.dir.writes) != 0 {
				t.Errorf("writes = %v, want none", env.dir.writes)
			}
			if strings.Contains(logs.String(), "hunter2") {
				t.Errorf("log contains the RDN value:\n%s", logs.String())
			}
		})
	}
}

func TestWriteEntriesLDAPErrors(t *testing.T) {
	// A failed add logs how many attributes it carried, a failed rename the
	// DN it aimed at; neither logs values.
	const (
		addLog    = `msg="add rejected" profile=dev dn="uid=n,dc=example,dc=org" attributes=3 code=`
		deleteLog = `msg="delete rejected" profile=dev dn="uid=n,dc=example,dc=org" code=`
		renameLog = `msg="rename rejected" profile=dev dn="uid=n,dc=example,dc=org" newDN="uid=m,ou=x,dc=example,dc=org" code=`
		setLog    = `msg="password rejected" profile=dev dn="uid=n,dc=example,dc=org" method=ssha code=`
	)
	tests := []struct {
		name       string
		path       string
		body       string
		err        error
		wantStatus int
		wantCode   string
		wantAttr   string
		wantLog    string
	}{
		{
			name: "add: entry exists", path: "entries/add", body: addBody,
			err:        ldap.NewError(ldap.LDAPResultEntryAlreadyExists, errors.New("")),
			wantStatus: http.StatusConflict, wantCode: "conflict", wantLog: addLog,
		},
		{
			name: "add: syntax names the attribute", path: "entries/add", body: addBody,
			err:        ldap.NewError(ldap.LDAPResultInvalidAttributeSyntax, errors.New("description: value #0 invalid per syntax")),
			wantStatus: http.StatusUnprocessableEntity, wantCode: "rejected", wantAttr: "description", wantLog: addLog,
		},
		{
			name: "add: naming violation", path: "entries/add", body: addBody,
			err:        ldap.NewError(ldap.LDAPResultNamingViolation, errors.New("value of naming attribute 'uid' is not present in entry")),
			wantStatus: http.StatusUnprocessableEntity, wantCode: "rejected", wantAttr: "uid", wantLog: addLog,
		},
		{
			name: "add: network error names nothing", path: "entries/add", body: addBody,
			err:        ldap.NewError(ldap.ErrorNetwork, errors.New("description: connection reset")),
			wantStatus: http.StatusBadGateway, wantCode: "network", wantLog: addLog,
		},
		{
			name: "delete: non-leaf", path: "entries/delete", body: deleteBody,
			err:        ldap.NewError(ldap.LDAPResultNotAllowedOnNonLeaf, errors.New("subordinate objects must be deleted first")),
			wantStatus: http.StatusUnprocessableEntity, wantCode: "rejected", wantLog: deleteLog,
		},
		{
			name: "rename: taken DN names nothing", path: "entries/rename", body: renameBody,
			err:        ldap.NewError(ldap.LDAPResultEntryAlreadyExists, errors.New("uid: already exists")),
			wantStatus: http.StatusConflict, wantCode: "conflict", wantLog: renameLog,
		},
		{
			name: "password: a policy refusal names nothing", path: "entries/password", body: setBody,
			err:        ldap.NewError(ldap.LDAPResultConstraintViolation, errors.New("password fails quality checking policy")),
			wantStatus: http.StatusUnprocessableEntity, wantCode: "rejected", wantLog: setLog,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			env := newTestEnvWith(t, Options{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
			connectTo(t, env, `{"profile":"dev"}`)
			env.dir.writeErr = tc.err
			rec := env.do(t, http.MethodPost, "/api/c/dev/"+tc.path, tc.body)
			var e apiError
			_ = json.Unmarshal(rec.Body.Bytes(), &e)
			if rec.Code != tc.wantStatus || e.Code != tc.wantCode || e.Attribute != tc.wantAttr {
				t.Errorf("%s = %d %+v, want %d %s attribute %q", tc.path, rec.Code, e, tc.wantStatus, tc.wantCode, tc.wantAttr)
			}
			if !strings.Contains(logs.String(), tc.wantLog+tc.wantCode) || strings.Contains(logs.String(), "secret-value") {
				t.Errorf("log = %s, want %q without values", logs.String(), tc.wantLog+tc.wantCode)
			}
		})
	}
}

// TestRefusalLogsRedactSecretDNs checks that a refused write never logs a DN
// with a secret attribute type in any RDN, nor one go-ldap cannot parse: the
// value would land in the log.
func TestRefusalLogsRedactSecretDNs(t *testing.T) {
	const oc = `{"name":"objectClass","values":["top"]}`
	const applyDN = "cn=n,2.5.4.35=hunter2,dc=x"
	tests := []struct {
		name string
		path string
		body string
	}{
		{name: "add below a secret RDN", path: "entries/add", body: `{"dn":"cn=n,userPassword=hunter2,dc=x","attributes":[` + oc + `]}`},
		{name: "delete below a secret RDN", path: "entries/delete", body: `{"dn":"cn=n,userPassword=hunter2,dc=x"}`},
		{name: "delete of a DN go-ldap cannot parse", path: "entries/delete", body: `{"dn":"hunter2"}`},
		{name: "move below a secret RDN", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"uid=m","newParent":"OID.2.5.4.35=hunter2,dc=x"}`},
		{name: "apply below a secret RDN", path: "changes/apply", body: `{"entries":[{"dn":"` + applyDN + `","changes":[{"op":"add","attr":"description","values":["x"]}]}]}`},
		{name: "password below a secret RDN", path: "entries/password", body: `{"dn":"cn=n,userPassword=hunter2,dc=x","password":"p","method":"ssha"}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			env := newTestEnvWith(t, Options{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
			connectTo(t, env, `{"profile":"dev"}`)
			noSuch := ldap.NewError(ldap.LDAPResultNoSuchObject, errors.New(""))
			env.dir.writeErr = noSuch
			env.dir.modifyErr = map[string]error{applyDN: noSuch}
			env.do(t, http.MethodPost, "/api/c/dev/"+tc.path, tc.body)
			got := logs.String()
			if !strings.Contains(got, " rejected") || !strings.Contains(got, "<redacted>") || strings.Contains(got, "hunter2") {
				t.Errorf("log = %s, want a refusal with the DN redacted", got)
			}
		})
	}
}

// TestSuccessLogsRedactSecretDNs checks that a write that succeeds never logs
// a DN with a secret attribute type in any RDN either: an entry below one can
// exist on the server, and a parent is not checked like a new RDN is.
func TestSuccessLogsRedactSecretDNs(t *testing.T) {
	const oc = `{"name":"objectClass","values":["top"]}`
	tests := []struct {
		name    string
		path    string
		body    string
		wantMsg string
	}{
		{name: "add below a secret RDN", path: "entries/add", body: `{"dn":"cn=n,userPassword=hunter2,dc=x","attributes":[` + oc + `]}`, wantMsg: "msg=added"},
		{name: "delete below a secret RDN", path: "entries/delete", body: `{"dn":"cn=n,userPassword=hunter2,dc=x"}`, wantMsg: "msg=deleted"},
		{name: "rename below a secret RDN", path: "entries/rename", body: `{"dn":"uid=n,userPassword=hunter2,dc=x","newRDN":"uid=m"}`, wantMsg: "msg=renamed"},
		{name: "move below a secret RDN", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"uid=m","newParent":"OID.2.5.4.35=hunter2,dc=x"}`, wantMsg: "msg=renamed"},
		{name: "apply below a secret RDN", path: "changes/apply", body: `{"entries":[{"dn":"cn=n,2.5.4.35=hunter2,dc=x","changes":[{"op":"add","attr":"description","values":["x"]}]}]}`, wantMsg: "msg=modified"},
		{name: "password below a secret RDN", path: "entries/password", body: `{"dn":"cn=n,userPassword=hunter2,dc=x","password":"p","method":"ssha"}`, wantMsg: `msg="password set"`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			env := newTestEnvWith(t, Options{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
			connectTo(t, env, `{"profile":"dev"}`)
			if rec := env.do(t, http.MethodPost, "/api/c/dev/"+tc.path, tc.body); rec.Code != http.StatusOK {
				t.Fatalf("%s = %d %s, want 200", tc.path, rec.Code, rec.Body)
			}
			got := logs.String()
			if !strings.Contains(got, tc.wantMsg) || !strings.Contains(got, "<redacted>") || strings.Contains(got, "hunter2") {
				t.Errorf("log = %s, want %s with the DN redacted", got, tc.wantMsg)
			}
		})
	}
}

// TestWriteEntriesNeedASession checks that every entry write answers 401
// before anything else when the browser has no session for the profile.
func TestWriteEntriesNeedASession(t *testing.T) {
	env := newTestEnv(t)
	for _, path := range []string{"entries/add", "entries/delete", "entries/rename", "entries/password"} {
		rec := env.do(t, http.MethodPost, "/api/c/dev/"+path, deleteBody)
		if rec.Code != http.StatusUnauthorized || errorCode(t, rec) != "not_connected" {
			t.Errorf("%s without a session = %d %s, want 401 not_connected", path, rec.Code, rec.Body)
		}
	}
}

// TestSetPasswordPassesItAsTyped checks that nothing trims the password and
// that the limit counts bytes: 256 x "é" is 512 bytes and allowed.
func TestSetPasswordPassesItAsTyped(t *testing.T) {
	env := connected(t)
	env.dir.info.PasswordModify = true
	for _, typed := range []string{" pa ss wörd ", strings.Repeat("é", 256)} {
		body, _ := json.Marshal(map[string]string{"dn": "uid=n,dc=example,dc=org", "password": typed, "method": "server"})
		rec := env.do(t, http.MethodPost, "/api/c/dev/entries/password", string(body))
		if rec.Code != http.StatusOK || env.dir.password != typed {
			t.Errorf("password %q = %d %s, directory got %q", typed, rec.Code, rec.Body, env.dir.password)
		}
	}
}

func TestSetPasswordOnActiveDirectory(t *testing.T) {
	var logs bytes.Buffer
	env := newTestEnvWith(t, Options{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
	env.dir.info = ldapx.Info{BaseDN: "dc=example,dc=org", ActiveDirectory: true}
	connectTo(t, env, `{"profile":"dev"}`)
	set := func() (int, apiError) {
		t.Helper()
		// A method OpenLDAP would refuse: AD ignores it.
		rec := env.do(t, http.MethodPost, "/api/c/dev/entries/password",
			`{"dn":"cn=n,dc=example,dc=org","password":"secret-value","method":"any"}`)
		var e apiError
		_ = json.Unmarshal(rec.Body.Bytes(), &e)
		return rec.Code, e
	}

	if code, e := set(); code != http.StatusBadRequest ||
		e.Message != "Active Directory accepts passwords only over an encrypted connection" || len(env.dir.writes) != 0 {
		t.Errorf("unencrypted = %d %+v, writes %v, want 400 about encryption and nothing written", code, e, env.dir.writes)
	}

	env.dir.info.Encrypted = true
	if code, e := set(); code != http.StatusOK {
		t.Fatalf("encrypted = %d %+v, want 200", code, e)
	}
	const setLog = `msg="password set" profile=dev dn="cn=n,dc=example,dc=org" method=unicodePwd`
	if !strings.Contains(logs.String(), setLog) {
		t.Errorf("log lacks %q:\n%s", setLog, logs.String())
	}

	env.dir.writeErr = ldap.NewError(ldap.LDAPResultConstraintViolation,
		errors.New("0000052D: Constraint violation - check_password_restrictions: the password is too short"))
	if code, e := set(); code != http.StatusUnprocessableEntity || e.Code != "rejected" || e.Reason != "password does not meet the policy" {
		t.Errorf("policy refusal = %d %+v, want 422 rejected with the policy reason", code, e)
	}
	const failLog = `msg="password rejected" profile=dev dn="cn=n,dc=example,dc=org" method=unicodePwd code=rejected`
	if !strings.Contains(logs.String(), failLog) || strings.Contains(logs.String(), "secret-value") {
		t.Errorf("log = %s, want %q and no password", logs.String(), failLog)
	}
}
