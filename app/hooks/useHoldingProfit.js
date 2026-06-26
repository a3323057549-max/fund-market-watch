import { useCallback, useRef } from 'react';
import { isArray, isNumber, isString } from 'lodash';
import { useStorageStore } from '../stores';
import { useTradingDay } from './useTradingDay';
import { formatDate, toTz, isNavUpdated, shouldShowTodayProfit } from '../lib/fundHelpers';

/**
 * 基金持仓与当日/累计收益计算逻辑自定义 Hook
 * @param {object} deps
 * @param {string | null} deps.activeGroupId - 当前活跃分组 ID
 */
export function useHoldingProfit({ activeGroupId } = {}) {
  const { isTradingDay } = useTradingDay();
  const todayStr = formatDate();
  const showTodayProfit = shouldShowTodayProfit(isTradingDay);
  const cacheRef = useRef(new Map());

  const getHoldingProfit = useCallback(
    (fund, holding, scopeGroupIdOverride) => {
      if (!holding || !isNumber(holding.share)) return null;

      const txScope = scopeGroupIdOverride !== undefined ? scopeGroupIdOverride : activeGroupId;

      const hasExactTodayData = isString(fund.jzrq) && fund.jzrq === todayStr;
      const hasTodayData = isNavUpdated(fund.jzrq, todayStr, fund.confirmDays);
      const hasTodayValuation = isString(fund.gztime) && fund.gztime.startsWith(todayStr);
      const canCalcTodayProfit = hasTodayData || hasTodayValuation;

      // 分红与基本份额相关的计算缓存
      const currentStore = useStorageStore.getState();
      const cachedDivs = currentStore.fundDividends?.[fund.code]?.list;
      const txs = currentStore.transactions?.[fund.code] || [];

      const cacheKey = `${fund.code}_${txScope}`;
      const cached = cacheRef.current.get(cacheKey);
      const isCacheValid =
        cached &&
        cached.txsRef === txs &&
        cached.cachedDivsRef === cachedDivs &&
        cached.share === holding.share &&
        cached.firstPurchaseDate === holding.firstPurchaseDate &&
        cached.dividendMethod === holding.dividendMethod &&
        cached.txScope === txScope &&
        cached.todayStr === todayStr &&
        cached.canCalcTodayProfit === canCalcTodayProfit;

      let extraShares = 0;
      let dividendCash = 0;
      let shareForTodayProfit = holding.share;

      if (isCacheValid) {
        extraShares = cached.extraShares;
        dividendCash = cached.dividendCash;
        shareForTodayProfit = cached.shareForTodayProfit;
      } else {
        // 1. 计算分红逻辑
        if (cachedDivs && isArray(cachedDivs)) {
          let earliestDate = holding.firstPurchaseDate;
          if (!earliestDate) {
            for (const tx of txs) {
              if (tx.type !== 'buy' || !tx.date) continue;
              const gid = tx.groupId || null;
              if (
                txScope !== undefined ? (txScope ? gid !== txScope : gid) : activeGroupId ? gid !== activeGroupId : gid
              )
                continue;
              if (!earliestDate || tx.date < earliestDate) earliestDate = tx.date;
            }
          }

          if (earliestDate) {
            const getShareAtDate = (date) => {
              let s = 0;
              let hasTx = false;
              for (const tx of txs) {
                const gid = tx.groupId || null;
                if (
                  txScope !== undefined
                    ? txScope
                      ? gid !== txScope
                      : gid
                    : activeGroupId
                      ? gid !== activeGroupId
                      : gid
                )
                  continue;
                if (tx.isHistoryOnly) continue;
                if (tx.date <= date) {
                  hasTx = true;
                  if (tx.type === 'buy') s += Number(tx.share) || 0;
                  if (tx.type === 'sell') s -= Number(tx.share) || 0;
                }
              }
              if (hasTx) return Math.max(0, s);
              if (date >= earliestDate) return holding.share;
              return 0;
            };

            const sortedDivs = [...cachedDivs].sort((a, b) => a.date.localeCompare(b.date));
            for (const div of sortedDivs) {
              if (div.date < earliestDate) continue;
              if (div.date > todayStr) continue;
              const baseShare = getShareAtDate(div.date);
              if (baseShare > 0) {
                const actualShare = baseShare + extraShares;
                if (!holding.dividendMethod || holding.dividendMethod === 'reinvest') {
                  if (div.nav > 0) {
                    extraShares += (actualShare * div.dividend) / div.nav;
                  }
                } else {
                  // 现金分红 (cash)
                  dividendCash += actualShare * div.dividend;
                }
              }
            }
          }
        }

        // 2. 计算有效份额及当日收益口径份额
        let effectiveShare = holding.share;
        if (!holding.dividendMethod || holding.dividendMethod === 'reinvest') {
          effectiveShare += extraShares;
        }

        shareForTodayProfit = effectiveShare;

        if (canCalcTodayProfit) {
          let buyToday = 0;
          let sellToday = 0;
          const list = txs;
          for (const tx of list) {
            if (!tx || tx.date !== todayStr) continue;
            const gid = tx.groupId || null;
            if (txScope) {
              if (gid !== txScope) continue;
            } else {
              if (gid) continue;
            }
            if (tx.isHistoryOnly) continue;
            const s = Number(tx.share);
            if (!Number.isFinite(s) || s <= 0) continue;
            if (tx.type === 'buy') buyToday += s;
            else if (tx.type === 'sell') sellToday += s;
          }
          shareForTodayProfit = Math.max(0, effectiveShare - buyToday + sellToday);
        }

        // 写入缓存
        cacheRef.current.set(cacheKey, {
          txsRef: txs,
          cachedDivsRef: cachedDivs,
          share: holding.share,
          firstPurchaseDate: holding.firstPurchaseDate,
          dividendMethod: holding.dividendMethod,
          txScope,
          todayStr,
          canCalcTodayProfit,
          extraShares,
          dividendCash,
          shareForTodayProfit
        });
      }

      let effectiveShare = holding.share;
      if (!holding.dividendMethod || holding.dividendMethod === 'reinvest') {
        effectiveShare += extraShares;
      }
      // QDII funds often publish the previous overseas trading day's NAV during the next China trading day.
      // In that state, the next-period valuation can be stale/noisy; account daily profit should follow latest NAV change.
      const latestNavChange = fund.zzl !== undefined ? Number(fund.zzl) : Number.NaN;
      const qdiiCodes = new Set(['012920', '013128', '016452', '019172']);
      const isQdiiLike = qdiiCodes.has(String(fund.code || '')) || /QDII|纳斯达克|全球|恒生科技/i.test(String(fund.name || ''));
      const preferLatestNavChange =
        isQdiiLike && Number.isFinite(latestNavChange) && fund.dwjz != null && fund.dwjz !== '';
      const useValuation = preferLatestNavChange
        ? false
        : hasTodayValuation && !hasExactTodayData
          ? true
          : isTradingDay && !hasTodayData;

      let currentNav;
      let profitToday;
      let principalToday = isNumber(holding.cost) ? holding.cost * shareForTodayProfit : 0;
      const accountAssetValue = Number(holding.accountAssetValue);
      const accountDailyProfit = Number(holding.accountDailyProfit);
      const accountHoldProfit = Number(holding.accountHoldProfit);
      const dailyProfitShare = Number(holding.dailyProfitShare);
      const hasAccountAssetValue = Number.isFinite(accountAssetValue);
      const hasAccountDailyProfit = Number.isFinite(accountDailyProfit);
      const hasAccountHoldProfit = Number.isFinite(accountHoldProfit);
      const hasDailyProfitShare = Number.isFinite(dailyProfitShare) && dailyProfitShare > 0;
      const useLatestNavDeltaForDailyProfit =
        holding.dailyProfitMode === 'latest_nav_delta' && preferLatestNavChange;

      if (!useValuation) {
        currentNav = Number(fund.dwjz);
        if (!currentNav) return null;

        if (canCalcTodayProfit) {
          const amountByCost = isNumber(holding.cost)
            ? holding.cost * shareForTodayProfit
            : shareForTodayProfit * currentNav;

          if (preferLatestNavChange) {
            const basisShare = useLatestNavDeltaForDailyProfit && hasDailyProfitShare ? dailyProfitShare : shareForTodayProfit;
            const previousNav = currentNav / (1 + latestNavChange / 100);
            principalToday = previousNav * basisShare;
            profitToday = (currentNav - previousNav) * basisShare;
          } else {
            const lastNav = fund.lastNav != null && fund.lastNav !== '' ? Number(fund.lastNav) : null;
            if (lastNav && Number.isFinite(lastNav) && lastNav > 0) {
              profitToday = (currentNav - lastNav) * shareForTodayProfit;
            } else {
              const gz = isString(fund.gztime) ? toTz(fund.gztime) : null;
              const jz = isString(fund.jzrq) ? toTz(fund.jzrq) : null;
              const preferGszzl =
                !!gz && !!jz && gz.isValid() && jz.isValid() && gz.startOf('day').isAfter(jz.startOf('day'));

              let rate;
              if (preferGszzl) {
                rate = Number(fund.gszzl);
              } else {
                const zzl = fund.zzl !== undefined ? Number(fund.zzl) : Number.NaN;
                rate = Number.isFinite(zzl) ? zzl : Number(fund.gszzl);
              }
              if (!Number.isFinite(rate)) rate = 0;
              profitToday = amountByCost - amountByCost / (1 + rate / 100);
            }
          }
        } else {
          profitToday = null;
        }
      } else {
        currentNav = isNumber(fund.gsz) ? fund.gsz : Number(fund.dwjz);

        if (!currentNav) return null;

        if (canCalcTodayProfit) {
          const amount = shareForTodayProfit * currentNav;
          const gzChange = Number(fund.gszzl) || 0;
          profitToday = amount * (gzChange / 100);
        } else {
          profitToday = null;
        }
      }
      // Holding amount always uses confirmed NAV when available.
      const exactNav = Number(fund.dwjz) || currentNav;
      const amount = hasAccountAssetValue ? accountAssetValue : effectiveShare * exactNav;

      // 总收益 = (确权净值 * 当前有效份额) - 成本总额 + 现金分红
      const profitTotal = hasAccountHoldProfit
        ? accountHoldProfit
        : isNumber(holding.cost)
          ? exactNav * effectiveShare - holding.cost * holding.share + dividendCash
          : null;

      const resolvedProfitToday =
        showTodayProfit && hasAccountDailyProfit && !useLatestNavDeltaForDailyProfit
          ? accountDailyProfit
          : showTodayProfit
            ? profitToday
            : null;

      return {
        amount,
        nav: exactNav,
        profitToday: resolvedProfitToday,
        profitTotal,
        principalToday: resolvedProfitToday == null ? 0 : hasAccountAssetValue && !useLatestNavDeltaForDailyProfit ? accountAssetValue : principalToday
      };
    },
    [showTodayProfit, todayStr, activeGroupId]
  );

  return { getHoldingProfit };
}
