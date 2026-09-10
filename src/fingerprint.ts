/**
 * Device Fingerprint Generator for Rate Limit Mitigation
 *
 * Generates randomized device fingerprints to help distribute API usage
 * across different apparent device identities.
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import { getAntigravityVersion } from "./constants.js";

const OS_VERSIONS: Record<string, string[]> = {
	darwin: ["10.15.7", "11.6.8", "12.6.3", "13.5.2", "14.2.1", "14.5"],
	win32: ["10.0.19041", "10.0.19042", "10.0.19043", "10.0.22000", "10.0.22621", "10.0.22631"],
};

const ARCHITECTURES = ["x64", "arm64"];

const IDE_TYPES = ["ANTIGRAVITY"] as const;

const SDK_CLIENTS = [
	"google-cloud-sdk vscode_cloudshelleditor/0.1",
	"google-cloud-sdk vscode/1.86.0",
	"google-cloud-sdk vscode/1.87.0",
	"google-cloud-sdk vscode/1.96.0",
];

export interface ClientMetadata {
	ideType: string;
	platform: string;
	pluginType: string;
}

export interface Fingerprint {
	deviceId: string;
	sessionToken: string;
	userAgent: string;
	apiClient: string;
	clientMetadata: ClientMetadata;
	createdAt: number;
	quotaUser?: string;
}

export interface FingerprintVersion {
	fingerprint: Fingerprint;
	timestamp: number;
	reason: "initial" | "regenerated" | "restored";
}

export const MAX_FINGERPRINT_HISTORY = 5;

export interface FingerprintHeaders {
	"User-Agent": string;
}

const PLATFORM_CHOICES = ["darwin", "win32"] as const;

function randomFrom<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]!;
}

function platformToDisplayName(platform: string): "WINDOWS" | "MACOS" {
	return platform === "win32" ? "WINDOWS" : "MACOS";
}

function generateDeviceId(): string {
	return crypto.randomUUID();
}

function generateSessionToken(): string {
	return crypto.randomBytes(16).toString("hex");
}

export function generateFingerprint(): Fingerprint {
	const platform = randomFrom(PLATFORM_CHOICES);
	const arch = randomFrom(ARCHITECTURES);

	return {
		deviceId: generateDeviceId(),
		sessionToken: generateSessionToken(),
		userAgent: `antigravity/${getAntigravityVersion()} ${platform}/${arch}`,
		apiClient: randomFrom(SDK_CLIENTS),
		clientMetadata: {
			ideType: randomFrom(IDE_TYPES),
			platform: platformToDisplayName(platform),
			pluginType: "GEMINI",
		},
		createdAt: Date.now(),
	};
}

export function collectCurrentFingerprint(): Fingerprint {
	const platform = os.platform();
	const arch = os.arch();

	return {
		deviceId: generateDeviceId(),
		sessionToken: generateSessionToken(),
		userAgent: `antigravity/${getAntigravityVersion()} ${platform}/${arch}`,
		apiClient: "google-cloud-sdk vscode_cloudshelleditor/0.1",
		clientMetadata: {
			ideType: "ANTIGRAVITY",
			platform: platformToDisplayName(platform),
			pluginType: "GEMINI",
		},
		createdAt: Date.now(),
	};
}

export function updateFingerprintVersion(fingerprint: Fingerprint): boolean {
	const currentVersion = getAntigravityVersion();
	const versionPattern = /^(antigravity\/)([\d.]+)/;
	const match = fingerprint.userAgent.match(versionPattern);

	if (!match || match[2] === currentVersion) {
		return false;
	}

	fingerprint.userAgent = fingerprint.userAgent.replace(versionPattern, `$1${currentVersion}`);
	return true;
}

export function buildFingerprintHeaders(fingerprint: Fingerprint | null): Partial<FingerprintHeaders> {
	if (!fingerprint) {
		return {};
	}
	return {
		"User-Agent": fingerprint.userAgent,
	};
}

let sessionFingerprint: Fingerprint | null = null;

export function getSessionFingerprint(): Fingerprint {
	if (!sessionFingerprint) {
		sessionFingerprint = generateFingerprint();
	}
	return sessionFingerprint;
}

export function regenerateSessionFingerprint(): Fingerprint {
	sessionFingerprint = generateFingerprint();
	return sessionFingerprint;
}
