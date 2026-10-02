export const REQUEST_ACTIONS = Object.freeze({
	BLOCKED: 'BLOCKED',
	ALLOWED: 'ALLOWED',
	FLAGGED: 'FLAGGED'
});

function includesDomain(list, domain) {
	return Array.isArray(list) && typeof domain === 'string' && list.some((entry) =>
		typeof entry === 'string' &&
		(domain === entry || domain.endsWith(`.${entry}`))
	);
}

export function decideRequest(analysis, settings, heuristic, blockedByDnr = false) {
	if (blockedByDnr) {
		return {
			action: REQUEST_ACTIONS.BLOCKED,
			policy: 'BLOCK',
			reason: 'The browser blocked this request with a DNR rule.'
		};
	}

	if (!analysis?.isThirdParty || !analysis.siteDomain || !analysis.domain) {
		return {
			action: REQUEST_ACTIONS.ALLOWED,
			policy: 'ALLOW',
			reason: 'This is not a confirmed third-party request.'
		};
	}

	const siteSettings = settings?.sites?.[analysis.siteDomain] ?? {};
	const siteProtectionEnabled = siteSettings.protectionEnabled !== false;
	const siteTrusted = includesDomain(settings?.allowlistedSites, analysis.siteDomain);
	const trackerKeys = [analysis.trackerId, analysis.domain].filter(Boolean);
	const trackerAllowed = trackerKeys.some((trackerKey) =>
		includesDomain(settings?.globalAllowlist, trackerKey) ||
		includesDomain(siteSettings.allowedTrackers, trackerKey)
	);

	if (
		settings?.globalProtection === false ||
		!siteProtectionEnabled ||
		siteTrusted ||
		trackerAllowed
	) {
		return {
			action: REQUEST_ACTIONS.ALLOWED,
			policy: 'ALLOW',
			reason: siteTrusted || trackerAllowed
				? 'An allow exception applies.'
				: 'Protection is disabled for this request.'
		};
	}

	if (includesDomain(settings?.blocklist, analysis.domain)) {
		return {
			action: REQUEST_ACTIONS.ALLOWED,
			policy: 'BLOCK',
			reason: 'The request completed without a reported DNR block for this domain.'
		};
	}

	if (analysis.serviceType === 'service') {
		return {
			action: REQUEST_ACTIONS.ALLOWED,
			policy: 'ALLOW',
			reason: 'The catalog identifies this as a non-tracking service.'
		};
	}

	if (analysis.isTracker && analysis.serviceType === 'tracker') {
		return {
			action: REQUEST_ACTIONS.ALLOWED,
			policy: 'BLOCK',
			reason: 'The request completed without a reported DNR block for this known tracker.'
		};
	}

	if (heuristic?.classification === 'POSSIBLE' || heuristic?.classification === 'LIKELY') {
		return {
			action: REQUEST_ACTIONS.FLAGGED,
			policy: 'FLAG',
			reason: 'The unknown third-party request has tracking signals.'
		};
	}

	return {
		action: REQUEST_ACTIONS.ALLOWED,
		policy: 'ALLOW',
		reason: analysis.serviceType === 'service'
			? 'The catalog identifies this as a non-tracking service.'
			: 'No blocking rule or strong tracking signal matched.'
	};
}
