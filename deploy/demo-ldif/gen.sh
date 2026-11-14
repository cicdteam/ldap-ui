#!/bin/sh
# Regenerates demo.ldif: 250 people (more than one 200-row tree page), nested
# groups with a cycle, DNs with escaped commas and non-ASCII characters,
# userPassword values the UI must mask, photos, a certificate and values with
# language options.
#
# Also regenerates ad-demo.ldif for Samba AD, under OU=Demo: 50 people with
# titles and departments, nested groups, and 1600 bulk users in one group
# (above AD's MaxValRange of 1500 values).
#
# photos/avatar-*.jpg were drawn once by photos/gen.go (cd photos && go run
# gen.go). cert.der is a self-signed certificate made once with:
#   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc \
#     -keyout /dev/null -subj '/CN=User 001/O=Example Org' -days 3650 \
#     -outform DER -out cert.der
set -eu
cd "$(dirname "$0")"
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
b64file() { base64 <"$1" | tr -d '\n'; }
{
	cat <<'EOF'
dn: dc=example,dc=org
objectClass: dcObject
objectClass: organization
dc: example
o: Example Org

dn: ou=people,dc=example,dc=org
objectClass: organizationalUnit
ou: people

dn: ou=groups,dc=example,dc=org
objectClass: organizationalUnit
ou: groups

dn: ou=Sales\, EMEA,dc=example,dc=org
objectClass: organizationalUnit
ou: Sales, EMEA

dn: cn=Doe\, John,ou=Sales\, EMEA,dc=example,dc=org
objectClass: inetOrgPerson
cn: Doe, John
sn: Doe
uid: jdoe
mail: john.doe@example.org
manager: uid=user001,ou=people,dc=example,dc=org

EOF
	printf 'dn:: %s\nobjectClass: inetOrgPerson\ncn:: %s\nsn:: %s\nuid: jmueller\n\n' \
		"$(b64 'cn=Jürgen Müller,ou=Sales\, EMEA,dc=example,dc=org')" "$(b64 'Jürgen Müller')" "$(b64 'Müller')"
	i=1
	while [ "$i" -le 250 ]; do
		n=$(printf '%03d' "$i")
		printf 'dn: uid=user%s,ou=people,dc=example,dc=org\nobjectClass: inetOrgPerson\nobjectClass: posixAccount\nuid: user%s\ncn: User %s\nsn: %s\nmail: user%s@example.org\nuidNumber: %d\ngidNumber: 10000\nhomeDirectory: /home/user%s\nuserPassword: secret%s\n' \
			"$n" "$n" "$n" "$n" "$n" $((10000 + i)) "$n" "$n"
		# The first 20 people have a photo (the five avatars in turn), the
		# first five a name in German and a description in Russian, user001 a
		# certificate.
		if [ "$i" -le 20 ]; then
			a=$(((i - 1) % 5 + 1))
			printf 'jpegPhoto:: %s\n' "$(b64file "photos/avatar-$a.jpg")"
		fi
		if [ "$i" -le 5 ]; then
			printf 'cn;lang-de: Benutzer %s\ndescription;lang-ru:: %s\n' "$n" "$(b64 "Пользователь $n")"
		fi
		if [ "$i" -eq 1 ]; then
			printf 'userCertificate;binary:: %s\n' "$(b64file cert.der)"
		fi
		printf '\n'
		i=$((i + 1))
	done
	g='ou=groups,dc=example,dc=org'
	p='ou=people,dc=example,dc=org'
	printf 'dn: cn=devs,%s\nobjectClass: groupOfNames\ncn: devs\n' "$g"
	i=2
	while [ "$i" -le 10 ]; do printf 'member: uid=user%03d,%s\n' "$i" "$p"; i=$((i + 1)); done
	printf '\ndn: cn=staff,%s\nobjectClass: groupOfNames\ncn: staff\nmember: cn=devs,%s\nmember: uid=user001,%s\n\n' "$g" "$g" "$p"
	printf 'dn: cn=everyone,%s\nobjectClass: groupOfNames\ncn: everyone\nmember: cn=staff,%s\nmember: cn=Doe\\, John,ou=Sales\\, EMEA,dc=example,dc=org\n\n' "$g" "$g"
	printf 'dn: cn=loop-a,%s\nobjectClass: groupOfNames\ncn: loop-a\nmember: cn=loop-b,%s\nmember: uid=user002,%s\n\n' "$g" "$g" "$p"
	printf 'dn: cn=loop-b,%s\nobjectClass: groupOfNames\ncn: loop-b\nmember: cn=loop-a,%s\n\n' "$g" "$g"
} >demo.ldif

# Demo-Passw0rd! is a demo value, not a secret. Users 001-040 have it and are
# enabled (512), 041-045 have it and are disabled (514), 046-050 have no
# password, so Samba leaves them disabled with PASSWD_NOTREQD.
ad='OU=Demo,DC=corp,DC=example,DC=test'
p="OU=People,$ad"
g="OU=Groups,$ad"
# unicodePwd is the password in double quotes, in UTF-16LE.
pw=$(printf '"Demo-Passw0rd!"' | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')
group() { printf 'dn: CN=%s,%s\nobjectClass: group\nsAMAccountName: %s\n' "$1" "$g" "$1"; }
members() {
	m=$1
	while [ "$m" -le "$2" ]; do printf 'member: CN=User %03d,%s\n' "$m" "$p"; m=$((m + 1)); done
}
{
	printf 'dn: %s\nobjectClass: organizationalUnit\nou: Demo\n\n' "$ad"
	for ou in People Groups Bulk; do
		printf 'dn: OU=%s,%s\nobjectClass: organizationalUnit\nou: %s\n\n' "$ou" "$ad" "$ou"
	done
	i=1
	while [ "$i" -le 50 ]; do
		n=$(printf '%03d' "$i")
		if [ "$i" -le 15 ]; then
			dept=Engineering title='Software Engineer'
		elif [ "$i" -le 30 ]; then
			dept=Sales title='Account Manager'
		else
			dept=Support title='Support Specialist'
		fi
		printf 'dn: CN=User %s,%s\nobjectClass: user\nsAMAccountName: user%s\nuserPrincipalName: user%s@corp.example.test\ngivenName: User\nsn: %s\ndisplayName: User %s\nmail: user%s@corp.example.test\ntitle: %s\ndepartment: %s\n' \
			"$n" "$p" "$n" "$n" "$n" "$n" "$n" "$title" "$dept"
		if [ "$i" -eq 1 ]; then
			printf 'description: Demo user, password Demo-Passw0rd!\n'
		fi
		if [ "$i" -le 40 ]; then
			printf 'unicodePwd:: %s\nuserAccountControl: 512\n' "$pw"
		elif [ "$i" -le 45 ]; then
			printf 'unicodePwd:: %s\nuserAccountControl: 514\n' "$pw"
		fi
		printf '\n'
		i=$((i + 1))
	done
	i=1
	while [ "$i" -le 1600 ]; do
		printf 'dn: CN=Bulk %04d,OU=Bulk,%s\nobjectClass: user\nsAMAccountName: bulk%04d\n\n' "$i" "$ad" "$i"
		i=$((i + 1))
	done
	# Members exist before their groups: AD checks every member DN.
	group Engineering
	members 1 15
	printf '\n'
	group Sales
	members 16 30
	printf '\n'
	group Staff
	printf 'member: CN=Engineering,%s\nmember: CN=Sales,%s\n' "$g" "$g"
	members 31 40
	printf '\n'
	group Everyone
	printf 'member: CN=Staff,%s\n\n' "$g"
	group 'All Bulk'
	i=1
	while [ "$i" -le 1600 ]; do printf 'member: CN=Bulk %04d,OU=Bulk,%s\n' "$i" "$ad"; i=$((i + 1)); done
} >ad-demo.ldif
