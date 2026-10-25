/**
 * RDF vocabulary for the FrontierMemory claim graph.
 *
 * Mirrors the worlds ontology used in wazoo-memorybench (same namespaces, the
 * subset this pipeline emits) plus a Wazoo extension namespace for
 * trajectory provenance: which trajectory a claim was derived from, at which
 * turn, and with which PASS/FAIL outcome. Provenance is the thing SPARQL
 * gives us that plain note stores do not.
 */

export const RDF = Object.freeze({
  _iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  type: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
  Statement: "http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement",
} as const)

export const RDFS = Object.freeze({
  _iri: "http://www.w3.org/2000/01/rdf-schema#",
  label: "http://www.w3.org/2000/01/rdf-schema#label",
  comment: "http://www.w3.org/2000/01/rdf-schema#comment",
} as const)

export const XSD = Object.freeze({
  _iri: "http://www.w3.org/2001/XMLSchema#",
  string: "http://www.w3.org/2001/XMLSchema#string",
  integer: "http://www.w3.org/2001/XMLSchema#integer",
} as const)

export const SCHEMA = Object.freeze({
  _iri: "http://schema.org/",
  Conversation: "http://schema.org/Conversation",
  Message: "http://schema.org/Message",
  text: "http://schema.org/text",
  dateCreated: "http://schema.org/dateCreated",
  position: "http://schema.org/position",
  author: "http://schema.org/author",
  creator: "http://schema.org/creator",
  hasPart: "http://schema.org/hasPart",
  name: "http://schema.org/name",
} as const)

export const PROV = Object.freeze({
  _iri: "http://www.w3.org/ns/prov#",
  Entity: "http://www.w3.org/ns/prov#Entity",
  Activity: "http://www.w3.org/ns/prov#Activity",
  wasGeneratedBy: "http://www.w3.org/ns/prov#wasGeneratedBy",
  wasDerivedFrom: "http://www.w3.org/ns/prov#wasDerivedFrom",
  atTime: "http://www.w3.org/ns/prov#atTime",
} as const)

export const WORLDS = Object.freeze({
  _iri: "https://worlds.wazoo.dev/ns/memory#",
  Claim: "https://worlds.wazoo.dev/ns/memory#Claim",
  FactClaim: "https://worlds.wazoo.dev/ns/memory#FactClaim",
  EventClaim: "https://worlds.wazoo.dev/ns/memory#EventClaim",
  PreferenceClaim: "https://worlds.wazoo.dev/ns/memory#PreferenceClaim",
  RelationshipClaim: "https://worlds.wazoo.dev/ns/memory#RelationshipClaim",
  PlanClaim: "https://worlds.wazoo.dev/ns/memory#PlanClaim",
  claimSubject: "https://worlds.wazoo.dev/ns/memory#claimSubject",
  claimAction: "https://worlds.wazoo.dev/ns/memory#claimAction",
  claimObject: "https://worlds.wazoo.dev/ns/memory#claimObject",
  claimText: "https://worlds.wazoo.dev/ns/memory#claimText",
  claimWhen: "https://worlds.wazoo.dev/ns/memory#claimWhen",
  claimWhere: "https://worlds.wazoo.dev/ns/memory#claimWhere",
  status: "https://worlds.wazoo.dev/ns/memory#status",
  Active: "https://worlds.wazoo.dev/ns/memory#Active",
  Superseded: "https://worlds.wazoo.dev/ns/memory#Superseded",
} as const)

/**
 * Wazoo extension for FrontierMemory trajectory provenance. Not part of the
 * upstream worlds ontology: the benchmark corpus is a set of labeled
 * trajectories, and every claim must remember where it came from.
 */
export const WAZOO = Object.freeze({
  _iri: "https://wazoo.dev/ns/frontiermemory#",
  trajId: "https://wazoo.dev/ns/frontiermemory#trajId",
  turn: "https://wazoo.dev/ns/frontiermemory#turn",
  outcome: "https://wazoo.dev/ns/frontiermemory#outcome",
  speaker: "https://wazoo.dev/ns/frontiermemory#speaker",
  extractor: "https://wazoo.dev/ns/frontiermemory#extractor",
  Trajectory: "https://wazoo.dev/ns/frontiermemory#Trajectory",
  OutcomePass: "https://wazoo.dev/ns/frontiermemory#OutcomePass",
  OutcomeFail: "https://wazoo.dev/ns/frontiermemory#OutcomeFail",
  OutcomeUnknown: "https://wazoo.dev/ns/frontiermemory#OutcomeUnknown",
} as const)

export const TURTLE_PREFIXES = [
  `@prefix rdf: <${RDF._iri}> .`,
  `@prefix rdfs: <${RDFS._iri}> .`,
  `@prefix xsd: <${XSD._iri}> .`,
  `@prefix schema: <${SCHEMA._iri}> .`,
  `@prefix prov: <${PROV._iri}> .`,
  `@prefix worlds: <${WORLDS._iri}> .`,
  `@prefix wazoo: <${WAZOO._iri}> .`,
  `@prefix urn: <urn:> .`,
].join("\n")

export const SPARQL_PREFIXES = [
  `PREFIX rdf: <${RDF._iri}>`,
  `PREFIX rdfs: <${RDFS._iri}>`,
  `PREFIX xsd: <${XSD._iri}>`,
  `PREFIX schema: <${SCHEMA._iri}>`,
  `PREFIX prov: <${PROV._iri}>`,
  `PREFIX worlds: <${WORLDS._iri}>`,
  `PREFIX wazoo: <${WAZOO._iri}>`,
].join("\n")

export const CLAIM_TYPE_BY_NAME: Record<string, string> = {
  fact: WORLDS.FactClaim,
  event: WORLDS.EventClaim,
  preference: WORLDS.PreferenceClaim,
  relationship: WORLDS.RelationshipClaim,
  plan: WORLDS.PlanClaim,
}

export function outcomeTerm(outcome: Outcome): string {
  if (outcome === "PASS") return WAZOO.OutcomePass
  if (outcome === "FAIL") return WAZOO.OutcomeFail
  return WAZOO.OutcomeUnknown
}

export type Outcome = "PASS" | "FAIL" | "unknown"
