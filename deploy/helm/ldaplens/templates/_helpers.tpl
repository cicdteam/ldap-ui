{{- define "ldaplens.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Name and instance only, so that several releases share a namespace. */}}
{{- define "ldaplens.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ldaplens.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "ldaplens.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ldaplens.image" -}}
{{- with .Values.image -}}
{{- if .digest -}}
{{ .repository }}@{{ .digest }}
{{- else -}}
{{ .repository }}:{{ .tag | default $.Chart.AppVersion }}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
connections.yaml: the profiles, each caFile pointed at its caCerts key in the
mounted ConfigMap. Fails on what the chart refuses: it holds no password, so
every profile signs users in with bindDNTemplate.
*/}}
{{- define "ldaplens.connections" -}}
{{- if not .Values.connections -}}
{{- fail "connections is empty: add a profile with bindDNTemplate, such as uid={user},ou=people,dc=corp,dc=example" -}}
{{- end -}}
{{- $out := list -}}
{{- range $i, $p := .Values.connections -}}
{{- $at := printf "connections[%d] (%s)" $i $p.name -}}
{{- range $k := list "bindDN" "password" "passwordFile" "passwordEnv" -}}
{{- if hasKey $p $k -}}
{{- fail (printf "%s: remove %s and set bindDNTemplate: the chart runs per-user profiles only and holds no password" $at $k) -}}
{{- end -}}
{{- end -}}
{{- if not $p.bindDNTemplate -}}
{{- fail (printf "%s: set bindDNTemplate, such as uid={user},ou=people,dc=corp,dc=example: the chart runs per-user profiles only" $at) -}}
{{- end -}}
{{- with $p.caFile -}}
{{- if not (hasKey $.Values.caCerts .) -}}
{{- fail (printf "%s: caFile %s is not a key of caCerts: add the CA certificate as caCerts.%s" $at . .) -}}
{{- end -}}
{{- $p = merge (dict "caFile" (printf "/etc/ldaplens/config/%s" .)) $p -}}
{{- end -}}
{{- $out = append $out $p -}}
{{- end -}}
{{- dict "connections" $out | toYaml -}}
{{- end -}}
