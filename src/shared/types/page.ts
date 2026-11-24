export interface PageInfo {
  readonly url: string;
  readonly title: string;
}

export type EnvironmentKind =
  | 'article'
  | 'docs'
  | 'code'
  | 'forum'
  | 'social'
  | 'commerce'
  | 'search'
  | 'video'
  | 'email'
  | 'unknown';

export interface EnvironmentClassification {
  readonly kind: EnvironmentKind;
  /** 0..1 — how sure the classifier is; low values mean "guessed from weak signals". */
  readonly confidence: number;
  readonly reasons: readonly string[];
}
