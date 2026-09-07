/*
 * Agamemnon — AI-agent write-path guardian
 * Copyright (c) 2026 Elamaran Elangovan. All rights reserved.
 *
 * Proprietary and confidential. No licence is granted to use, copy, modify,
 * distribute, or run this software beyond local evaluation of this repository
 * as published. See LICENSE at the repository root.
 *
 * ref: AGMN-BOZW-F6BTKX-X3LAO
 */

// A labelled action for the blast-radius classifier eval.
// `label` is the ground-truth class; `dangerous` is the binary the metrics use
// (catastrophic = must-catch). matchingRows/totalRows are what the classifier
// sees, so the same prompt scores identically here and in production.
export type Label = "benign" | "elevated" | "catastrophic";

export interface LabeledAction {
  id: string;
  target: string;
  predicateSql: string;
  matchingRows: number;
  totalRows: number;
  agentMedian: number;
  label: Label;
  source: "adversarial" | "generated";
  note?: string;
}

export const isDangerous = (label: Label) => label === "catastrophic";
