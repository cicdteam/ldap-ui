import type { Schema } from './types'

const INTEGER = '1.3.6.1.4.1.1466.115.121.1.27'
const DN = '1.3.6.1.4.1.1466.115.121.1.12'
const IA5 = '1.3.6.1.4.1.1466.115.121.1.26'

/** An OpenLDAP-like schema for tests: the inetOrgPerson chain, OUs, groups, two auxiliary classes. */
export const directorySchema: Schema = {
  attributeTypes: [
    { oid: '2.5.4.0', names: ['objectClass'] },
    { oid: '2.5.4.3', names: ['cn', 'commonName'] },
    { oid: '2.5.4.4', names: ['sn'] },
    { oid: '2.5.4.11', names: ['ou'] },
    { oid: '2.5.4.13', names: ['description'] },
    { oid: '2.5.4.31', names: ['member'], syntax: DN },
    { oid: '0.9.2342.19200300.100.1.1', names: ['uid'] },
    { oid: '0.9.2342.19200300.100.1.3', names: ['mail'], syntax: IA5 },
    { oid: '1.3.6.1.1.1.1.0', names: ['uidNumber'], syntax: INTEGER, singleValue: true },
    { oid: '1.3.6.1.1.1.1.1', names: ['gidNumber'], syntax: INTEGER, singleValue: true },
    { oid: '1.3.6.1.1.1.1.3', names: ['homeDirectory'], syntax: IA5, singleValue: true },
    { oid: '1.3.6.1.1.1.1.4', names: ['loginShell'], syntax: IA5, singleValue: true },
    { oid: '1.3.6.1.1.1.1.5', names: ['shadowLastChange'], syntax: INTEGER, singleValue: true },
    { oid: '2.16.840.1.113730.3.1.3', names: ['employeeNumber'], singleValue: true },
    { oid: '2.5.4.35', names: ['userPassword'] },
    {
      oid: '2.5.18.1',
      names: ['createTimestamp'],
      usage: 'directoryOperation',
      noUserModification: true,
    },
  ],
  objectClasses: [
    { oid: '2.5.6.0', names: ['top'], kind: 'ABSTRACT', must: ['objectClass'] },
    {
      oid: '2.5.6.6',
      names: ['person'],
      kind: 'STRUCTURAL',
      sup: ['top'],
      must: ['sn', 'cn'],
      may: ['userPassword', 'description'],
    },
    {
      oid: '2.5.6.7',
      names: ['organizationalPerson'],
      kind: 'STRUCTURAL',
      sup: ['person'],
      may: ['ou'],
    },
    {
      oid: '2.16.840.1.113730.3.2.2',
      names: ['inetOrgPerson'],
      kind: 'STRUCTURAL',
      sup: ['organizationalPerson'],
      may: ['uid', 'mail', 'employeeNumber'],
    },
    {
      oid: '2.5.6.5',
      names: ['organizationalUnit'],
      kind: 'STRUCTURAL',
      sup: ['top'],
      must: ['ou'],
      may: ['description'],
    },
    {
      oid: '2.5.6.9',
      names: ['groupOfNames'],
      kind: 'STRUCTURAL',
      sup: ['top'],
      must: ['member', 'cn'],
      may: ['description'],
    },
    {
      oid: '1.3.6.1.1.1.2.2',
      names: ['posixGroup'],
      kind: 'STRUCTURAL',
      sup: ['top'],
      must: ['cn', 'gidNumber'],
      may: ['description'],
    },
    {
      oid: '2.5.6.14',
      names: ['device'],
      kind: 'STRUCTURAL',
      sup: ['top'],
      must: ['cn'],
      may: ['description'],
    },
    {
      oid: '1.3.6.1.1.1.2.0',
      names: ['posixAccount'],
      kind: 'AUXILIARY',
      sup: ['top'],
      must: ['cn', 'uid', 'uidNumber', 'gidNumber', 'homeDirectory'],
      may: ['userPassword', 'loginShell', 'description'],
    },
    {
      oid: '1.3.6.1.1.1.2.1',
      names: ['shadowAccount'],
      kind: 'AUXILIARY',
      sup: ['top'],
      must: ['uid'],
      may: ['shadowLastChange', 'description'],
    },
  ],
}
