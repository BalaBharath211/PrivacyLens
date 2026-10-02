import { findTracker } from '../tracker-db/tracker-db.js';

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
	'ac.uk', 'co.in', 'co.jp', 'co.nz', 'co.uk', 'com.au', 'com.br',
	'com.cn', 'com.mx', 'com.sg', 'net.au', 'org.uk'
]);

function parseWebUrl(value) {
	if (typeof value !== 'string') return null;

	try {
		const parsed = new URL(value);
		if (!['http:', 'https:'].includes(parsed.protocol)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function getRegisteredDomain(hostname) {
	if (typeof hostname !== 'string' || !hostname) return null;
	const normalized = hostname.toLowerCase().replace(/\.$/, '');
	if (normalized.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) {
		return normalized;
	}

	const labels = normalized.split('.').filter(Boolean);
	if (labels.length < 2) return normalized;
	const suffix = labels.slice(-2).join('.');
	const labelCount = MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) ? 3 : 2;
	return labels.slice(-labelCount).join('.');
}

export function analyzeRequest(details = {}) {
	const requestUrl = parseWebUrl(details.url);
	const requestHostname = requestUrl?.hostname.toLowerCase() ?? null;
	const requestDomain = getRegisteredDomain(requestHostname);
	const initiatorUrl = parseWebUrl(
		details.initiator || details.documentUrl || details.originUrl
	);
	const initiatorHostname = initiatorUrl?.hostname.toLowerCase() ?? null;
	const siteDomain = getRegisteredDomain(initiatorHostname);
	const isThirdParty = Boolean(
		siteDomain && requestDomain && siteDomain !== requestDomain
	);
	const tracker = requestHostname
		? findTracker(requestHostname, details.url)
		: null;

	return {
		url: typeof details.url === 'string' ? details.url : '',
		domain: requestHostname,
		registeredDomain: requestDomain,
		type: typeof details.type === 'string' ? details.type : 'other',
		initiator: initiatorUrl?.origin ?? null,
		initiatorDomain: initiatorHostname,
		siteDomain,
		isThirdParty,
		isTracker: tracker?.type === 'tracker',
		trackerId: tracker?.id ?? null,
		trackerName: tracker?.name ?? null,
		company: tracker?.company ?? null,
		category: tracker?.category ?? 'Unknown',
		purpose: tracker?.purpose ?? null,
		confidence: tracker?.confidence ?? 0,
		serviceType: tracker?.type ?? null,
		tabId: Number.isInteger(details.tabId) ? details.tabId : null,
		requestId: details.requestId ?? null
	};
}
