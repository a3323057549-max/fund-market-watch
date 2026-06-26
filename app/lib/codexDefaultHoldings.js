import { isArray, isPlainObject } from 'lodash';
import { storageStore } from '../stores';

const IMPORT_MARKER_KEY = 'codexDefaultHoldingsImportedAt';

const getBasePath = () => {
  const configured = process.env.NEXT_PUBLIC_BASE_PATH;
  if (configured) return configured.replace(/\/$/, '');
  return '';
};

export const applyCodexDefaultHoldings = async ({ force = false } = {}) => {
  if (typeof window === 'undefined') return { applied: false, reason: 'server' };

  const response = await fetch(`${getBasePath()}/codex-holdings.json`, {
    cache: 'no-store'
  });

  if (!response.ok) {
    return { applied: false, reason: 'missing' };
  }

  const data = await response.json();
  if (!isArray(data.funds) || !isPlainObject(data.holdings)) {
    return { applied: false, reason: 'invalid' };
  }

  const currentFunds = storageStore.getItem('funds', []);
  const currentMarker = storageStore.getItem(IMPORT_MARKER_KEY, '');
  const exportedAt = String(data.exportedAt || '');
  const shouldApply =
    force || !isArray(currentFunds) || currentFunds.length === 0 || (exportedAt && exportedAt !== currentMarker);

  if (!shouldApply) {
    return { applied: false, reason: 'current' };
  }

  storageStore.setItem('funds', JSON.stringify(data.funds));
  storageStore.setItem('holdings', JSON.stringify(data.holdings));

  if (isArray(data.favorites)) {
    storageStore.setItem('favorites', JSON.stringify(data.favorites));
  }
  if (isArray(data.groups)) {
    storageStore.setItem('groups', JSON.stringify(data.groups));
  }
  if (isPlainObject(data.groupHoldings)) {
    storageStore.setItem('groupHoldings', JSON.stringify(data.groupHoldings));
  }
  if (data.viewMode === 'list' || data.viewMode === 'card') {
    storageStore.setItem('viewMode', JSON.stringify(data.viewMode));
  }
  if (Number.isFinite(Number(data.refreshMs))) {
    storageStore.setItem('refreshMs', JSON.stringify(Number(data.refreshMs)));
  }

  storageStore.setItem(IMPORT_MARKER_KEY, JSON.stringify(exportedAt || new Date().toISOString()));

  return {
    applied: true,
    reason: 'loaded',
    codes: data.funds.map((fund) => fund?.code).filter(Boolean)
  };
};
