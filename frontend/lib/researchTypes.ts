/**
 * MYRAA — Research Interface Types
 * Strong typing for the Aurora Light Research Workspace.
 */

export type SourceType =
  | "OFFICIAL_DOCUMENTATION"
  | "OFFICIAL_API_REFERENCE"
  | "OFFICIAL_GITHUB"
  | "ACADEMIC"
  | "TRUSTED_TECHNICAL_SOURCE"
  | "COMMUNITY"
  | "FORUM"
  | "UNKNOWN";

export type EpistemicLabel = "FACT" | "INFERENCE" | "HYPOTHESIS" | "VERIFIED_CONCLUSION";

export type VerificationStatus =
  | "UNVERIFIED"
  | "CORROBORATED"
  | "CONTRADICTED"
  | "VERIFIED_CONCLUSION"
  | "INSUFFICIENT_EVIDENCE";

export interface ResearchMetricState {
  sources: number;
  claims: number;
  crossCheck: boolean;
  contradictions: number;
  citations: number;
}

export interface UIClaim {
  id: string;
  claim: string;
  evidence?: string;
  source: string;
  sourceUrl?: string;
  sourceType: SourceType | string;
  reliability: number;
  corroboration: number;
  hasContradiction?: boolean;
  epistemicLabel?: EpistemicLabel;
  verificationStatus?: VerificationStatus;
  publishedAt?: string;
  saved?: boolean;
}

export interface UISource {
  id: string;
  url: string;
  title: string;
  type: SourceType | string;
  domain?: string;
  reliabilityScore: number;
  snippet?: string;
  fetchedAt?: number;
  isDuplicate?: boolean;
  canonicalUrl?: string;
}

export interface UIKeyFinding {
  finding: string;
  supportingClaims: string[];
  citationSummary: string;
}

export interface UIContradiction {
  id: string;
  topic: string;
  claimA: string;
  claimB: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  resolution: string;
  resolutionExplanation: string;
}

export interface UIEpistemicSummary {
  verifiedConclusions: number;
  facts: number;
  inferences: number;
  hypotheses: number;
  uncertainties: string[];
}

export interface UISessionItem {
  sessionId: string;
  query: string;
  status: "ACTIVE" | "COMPLETE" | "FAILED" | "CANCELLED";
  startedAt: number;
  sourceCount?: number;
  claimCount?: number;
}
