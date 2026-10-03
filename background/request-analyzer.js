import { findTracker } from '../tracker-db/tracker-db.js';
import { getDomain as tldtsGetDomain } from '../tracker-db/tldts-bundle.js';

function isIpAddress(hostname) {
	if (hostname.startsWith('[') && hostname.endsWith(']')) return true;
	const parts = hostname.split('.');
	return parts.length === 4 && parts.every((part) => {
		if (!/^\d{1,3}$/.test(part)) return false;
		const octet = Number(part);
		return octet >= 0 && octet <= 255;
	});
}

function normalizeHostname(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed || /[\s\/?#@]/.test(trimmed)) return null;

	const withoutTrailingDots = trimmed.replace(/\.+$/, '');
	if (!withoutTrailingDots) return null;
	const parseValue = withoutTrailingDots.includes(':') &&
		!withoutTrailingDots.startsWith('[')
		? `[${withoutTrailingDots}]`
		: withoutTrailingDots;

	try {
		const parsed = new URL(`http://${parseValue}/`);
		if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/') {
			return null;
		}

		const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
		if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
			return null;
		}
		if (isIpAddress(hostname)) return null;

		const labels = hostname.split('.');
		if (labels.some((label) =>
			!label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
		)) {
			return null;
		}
		return hostname;
	} catch {
		return null;
	}
}

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

export function createRegisteredDomainResolver({
	getNativeApi = () => globalThis.chrome?.publicSuffix,
	fallbackGetDomain = tldtsGetDomain
} = {}) {
	return function resolveRegisteredDomain(hostname) {
		const normalized = normalizeHostname(hostname);
		if (!normalized) return null;

		try {
			const nativeApi = getNativeApi();
			if (typeof nativeApi?.getDomain === 'function') {
				const nativeDomain = nativeApi.getDomain(normalized, {
					allowIPAddress: false,
					allowPlainSuffix: false,
					allowUnknownSuffix: false,
					encoding: 'punycode'
				});
				const validNativeDomain = normalizeHostname(nativeDomain);
				if (validNativeDomain) return validNativeDomain;
			}
		} catch {
			// Native API failures fall back to the bundled Public Suffix List.
		}

		try {
			const domain = fallbackGetDomain(normalized, { allowPrivateDomains: true });
			return normalizeHostname(domain);
		} catch {
			return null;
		}
	};
}

const resolveRegisteredDomain = createRegisteredDomainResolver();

export function getRegisteredDomain(hostname) {
	return resolveRegisteredDomain(hostname);
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
