(async () => {
  const out = {};
  const val = (v) => { const t = typeof v; if (v === null) return 'null'; if (t === 'function') return 'fn'; if (t === 'object') { try { if (Array.isArray(v)) return 'arr' + v.length + ':' + JSON.stringify(v).slice(0, 120); return Object.prototype.toString.call(v) + (typeof v.length === 'number' ? '#' + v.length : ''); } catch { return 'obj?'; } } return t + ':' + String(v).slice(0, 160); };
  const skip = /^(on|webkit)|^(_|\$)/;
  const pega = (o, nome) => { const vistos = new Set(); let p = o; while (p && p !== Object.prototype) { for (const k of Object.getOwnPropertyNames(p)) { if (vistos.has(k) || skip.test(k)) continue; vistos.add(k); let v; try { v = o[k]; } catch (e) { out[nome + '.' + k] = 'THROW ' + e.name; continue; } if (typeof v === 'function') continue; out[nome + '.' + k] = val(v); } p = Object.getPrototypeOf(p); } };
  pega(document, 'doc'); pega(navigator, 'nav'); pega(screen, 'scr'); pega(location, 'loc'); pega(history, 'hist'); pega(performance, 'perf'); pega(window.chrome || {}, 'chrome');
  try { pega(navigator.connection, 'conn'); } catch {}
  try { pega(navigator.userAgentData, 'uad'); } catch {}
  try { pega(screen.orientation, 'ori'); } catch {}
  try { pega(window.visualViewport, 'vv'); } catch {}
  try { pega(document.documentElement, 'html'); } catch {}
  for (const k of ['name', 'origin', 'isSecureContext', 'crossOriginIsolated', 'length', 'closed', 'devicePixelRatio', 'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'screenX', 'screenY', 'scrollX', 'pageXOffset', 'frameElement', 'opener', 'status', 'origin', 'credentialless', 'originAgentCluster', 'event']) { try { out['w.' + k] = val(window[k]); } catch (e) { out['w.' + k] = 'THROW ' + e.name; } }
  try { out.ents = performance.getEntries().map((e) => e.entryType + ':' + e.initiatorType + ':' + String(e.name).replace(/[?#].*/, '').slice(-50) + ':' + e.nextHopProtocol + ':' + (e.deliveryType ?? '') + ':' + (e.renderBlockingStatus ?? '')).join(' | '); } catch (e) { out.ents = 'THROW'; }
  try { const h = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'fullVersionList', 'wow64', 'formFactors']); out.he = JSON.stringify(h); } catch (e) { out.he = 'THROW ' + e.name + ' ' + e.message; }
  try { out.perm = (await Promise.all(['notifications', 'geolocation', 'camera', 'microphone', 'clipboard-read', 'persistent-storage', 'storage-access'].map((n) => navigator.permissions.query({ name: n }).then((r) => n + '=' + r.state, (e) => n + '!' + e.name)))).join(','); } catch (e) { out.perm = 'THROW'; }
  try { const est = await navigator.storage.estimate(); out.quota = String(est.quota > 1e9); out.persisted = String(await navigator.storage.persisted()); } catch (e) { out.quota = 'THROW ' + e.name; }
  try { out.sa = String(await document.hasStorageAccess()); } catch (e) { out.sa = 'THROW ' + e.name; }
  try { out.cookieEnabled = navigator.cookieEnabled + ' ck=' + document.cookie.split(';').map((c) => c.split('=')[0].trim()).join('+'); } catch (e) { out.cookieEnabled = 'THROW'; }
  try { out.ls = typeof localStorage + ':' + localStorage.length; } catch (e) { out.ls = 'THROW ' + e.name; }
  try { out.idb = String(!!indexedDB); const dbs = await indexedDB.databases(); out.idbs = dbs.map((d) => d.name).join(','); } catch (e) { out.idb = 'THROW ' + e.name; }
  try { out.caches = (await caches.keys()).join(','); } catch (e) { out.caches = 'THROW ' + e.name; }
  try { out.sw = String(navigator.serviceWorker.controller) + ':' + (await navigator.serviceWorker.getRegistrations()).length; } catch (e) { out.sw = 'THROW ' + e.name; }
  return out;
})()
