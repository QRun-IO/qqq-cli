/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * ESB helpers. A topic keeps its messages per trigger (subscription), and trigger names look like
 * `syncOrder.orderEvents` (process.destination); people know the process name. These find the
 * trigger a person means from the ESB overview, or say which ones there are.
 */

type Json = Record<string, unknown>

/** A trigger of a destination, as the overview lists it. */
export interface EsbTrigger {
  name: string
  processName?: string
  processLabel?: string
}

/** Thrown when the trigger cannot be chosen; the message lists the valid ones. */
export class EsbTriggerError extends Error {
  readonly triggers: EsbTrigger[]

  constructor(message: string, triggers: EsbTrigger[]) {
    super(message)
    this.name = 'EsbTriggerError'
    this.triggers = triggers
  }
}

/** The triggers of a destination in a GET /esb/overview document (empty when it is not listed). */
export function esbTriggersOf(overview: unknown, destination: string): EsbTrigger[] {
  const destinations = ((overview as Json | undefined)?.destinations ?? []) as Json[]
  const found = destinations.find((d) => d.name === destination || d.brokerName === destination)
  return ((found?.triggers ?? []) as Json[]).filter((t) => typeof t.name === 'string').map((t) => ({
    name: String(t.name),
    ...(typeof t.processName === 'string' ? { processName: t.processName } : {}),
    ...(typeof t.processLabel === 'string' ? { processLabel: t.processLabel } : {}),
  }))
}

function listed(triggers: EsbTrigger[]): string {
  return triggers.map((t) => `${t.name}${t.processName ? ` (process ${t.processName})` : ''}`).join(', ')
}

/**
 * The trigger name to read a topic's messages with: `given` as a trigger name, or as a process
 * name (or label) whose trigger on this destination is meant. Throws EsbTriggerError naming the
 * valid triggers when nothing is given, nothing matches, or a process has several triggers here.
 */
export function resolveEsbTrigger(triggers: EsbTrigger[], destination: string, given?: string): string {
  if (!triggers.length) throw new EsbTriggerError(`${destination} has no triggers${given ? ` (asked for ${given})` : ''}; a topic's messages are kept per trigger, so there is nothing to read.`, triggers)
  if (!given) throw new EsbTriggerError(`${destination} is a topic: its messages are kept per trigger; pass --trigger with one of: ${listed(triggers)}.`, triggers)
  const exact = triggers.find((t) => t.name === given)
  if (exact) return exact.name
  const lower = given.toLowerCase()
  const byProcess = triggers.filter((t) => t.processName === given || t.processName?.toLowerCase() === lower || t.processLabel?.toLowerCase() === lower)
  if (byProcess.length === 1) return byProcess[0]!.name
  if (byProcess.length > 1) throw new EsbTriggerError(`Process ${given} has ${byProcess.length} triggers on ${destination}; pass --trigger with one of: ${listed(byProcess)}.`, byProcess)
  throw new EsbTriggerError(`No trigger ${given} on ${destination}; its triggers: ${listed(triggers)}.`, triggers)
}
