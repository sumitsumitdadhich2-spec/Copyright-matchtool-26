'use client'

import { useEffect, useState } from 'react'
import {
  Check,
  CloudUpload,
  Cookie,
  Cpu,
  ExternalLink,
  HelpCircle,
  Loader2,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react'
import type { PublicStudioSettings } from '@/lib/studio-settings'
import type { StudioThinkingLevel } from '@/lib/studio-model-state'

const STUDIO_MODEL_DROPDOWN_OPTIONS = [
  'Argon',
  'Gemini 3.8 Flash',
  'Gemini 3.7 Flash',
  'Gemini 3.6 Flash',
] as const

interface Props {
  studio?: PublicStudioSettings
  onRefresh: () => void
}

export function StudioSettingsSection({ studio, onRefresh }: Props) {
  const [engine, setEngine] = useState<'api' | 'studio'>(studio?.chunkScanEngine ?? 'api')
  const [modelName, setModelName] = useState(studio?.studioModelName ?? 'Argon')
  const [thinkingLevel, setThinkingLevel] = useState<StudioThinkingLevel>(
    studio?.studioThinkingLevel ?? 'high',
  )
  const [maxOutputTokens, setMaxOutputTokens] = useState(studio?.studioMaxOutputTokens ?? 65536)
  const [maxInputTokensStr, setMaxInputTokensStr] = useState<string>(
    studio?.studioMaxInputTokens ? String(studio.studioMaxInputTokens) : '',
  )
  const [pageRecycleInterval, setPageRecycleInterval] = useState<number>(
    studio?.studioPageRecycleInterval ?? 5,
  )
  const [windowMinutes, setWindowMinutes] = useState(studio?.studioWindowMinutes ?? 5)
  const [shortPartMinutes, setShortPartMinutes] = useState(studio?.studioShortPartMinutes ?? 3)
  const [windowOverlapSec, setWindowOverlapSec] = useState(studio?.studioWindowOverlapSec ?? 0)
  const [offsetMode, setOffsetMode] = useState<'auto' | 'relative' | 'absolute'>(
    studio?.studioOffsetMode ?? 'auto',
  )
  const [lowMemoryChromeFlags, setLowMemoryChromeFlags] = useState<boolean>(
    studio?.studioLowMemoryChromeFlags ?? false,
  )
  const [disableDevShmUsage, setDisableDevShmUsage] = useState<boolean>(
    studio?.studioDisableDevShmUsage ?? true,
  )
  const [attachMovieFromDrive, setAttachMovieFromDrive] = useState<boolean>(
    studio?.studioAttachMovieFromDrive ?? false,
  )

  const [cookieText, setCookieText] = useState('')
  const [savingCookies, setSavingCookies] = useState(false)
  const [testingLogin, setTestingLogin] = useState(false)
  const [loginTestResult, setLoginTestResult] = useState<{
    loggedIn: boolean
    email?: string | null
    message: string
  } | null>(null)
  const [savingConfig, setSavingConfig] = useState(false)
  const [configSaved, setConfigSaved] = useState(false)
  const [connectingDrive, setConnectingDrive] = useState(false)
  const [showOAuthGuide, setShowOAuthGuide] = useState(false)
  const [resettingQuota, setResettingQuota] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!studio) return
    setEngine(studio.chunkScanEngine)
    setModelName(studio.studioModelName || 'Argon')
    setThinkingLevel(studio.studioThinkingLevel || 'high')
    setMaxOutputTokens(studio.studioMaxOutputTokens)
    setMaxInputTokensStr(studio.studioMaxInputTokens ? String(studio.studioMaxInputTokens) : '')
    setPageRecycleInterval(studio.studioPageRecycleInterval ?? 5)
    setWindowMinutes(studio.studioWindowMinutes)
    setShortPartMinutes(studio.studioShortPartMinutes)
    setWindowOverlapSec(studio.studioWindowOverlapSec)
    setOffsetMode(studio.studioOffsetMode)
    setLowMemoryChromeFlags(Boolean(studio.studioLowMemoryChromeFlags ?? false))
    setDisableDevShmUsage(
      studio.studioDisableDevShmUsage !== undefined ? Boolean(studio.studioDisableDevShmUsage) : true,
    )
    setAttachMovieFromDrive(Boolean(studio.studioAttachMovieFromDrive ?? false))
  }, [
    studio?.chunkScanEngine,
    studio?.studioModelName,
    studio?.studioThinkingLevel,
    studio?.studioMaxOutputTokens,
    studio?.studioMaxInputTokens,
    studio?.studioPageRecycleInterval,
    studio?.studioWindowMinutes,
    studio?.studioShortPartMinutes,
    studio?.studioWindowOverlapSec,
    studio?.studioOffsetMode,
    studio?.studioLowMemoryChromeFlags,
    studio?.studioDisableDevShmUsage,
    studio?.studioAttachMovieFromDrive,
  ])

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.data && typeof ev.data === 'object' && ev.data.type === 'cmt-drive-connected') {
        onRefresh()
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onRefresh])

  async function switchEngine(nextEngine: 'api' | 'studio') {
    setEngine(nextEngine)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunkScanEngine: nextEngine }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to switch chunk scan engine')
      return
    }
    onRefresh()
  }

  async function saveStudioParams() {
    setSavingConfig(true)
    setError(null)
    const trimmedMaxInput = maxInputTokensStr.trim()
    const parsedMaxInput =
      trimmedMaxInput === '' || trimmedMaxInput.toLowerCase() === 'auto'
        ? null
        : Number(trimmedMaxInput)
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studio: {
          chunkScanEngine: engine,
          studioModelName: modelName,
          studioThinkingLevel: thinkingLevel,
          studioMaxOutputTokens: Number(maxOutputTokens),
          studioMaxInputTokens:
            parsedMaxInput !== null && Number.isFinite(parsedMaxInput) && parsedMaxInput > 0
              ? Math.floor(parsedMaxInput)
              : null,
          studioPageRecycleInterval: Math.max(1, Math.min(100, Math.floor(Number(pageRecycleInterval) || 5))),
          studioWindowMinutes: Number(windowMinutes),
          studioShortPartMinutes: Number(shortPartMinutes),
          studioWindowOverlapSec: Number(windowOverlapSec),
          studioOffsetMode: offsetMode,
          studioLowMemoryChromeFlags: lowMemoryChromeFlags,
          studioDisableDevShmUsage: disableDevShmUsage,
          studioAttachMovieFromDrive: attachMovieFromDrive,
        },
      }),
    })
    setSavingConfig(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to save Studio settings')
      return
    }
    setConfigSaved(true)
    setTimeout(() => setConfigSaved(false), 2500)
    onRefresh()
  }

  async function resetExhaustedQuota(targetModel?: string | null) {
    setResettingQuota(true)
    setError(null)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetModelQuota: targetModel || true }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.error || 'Failed to reset model quota state')
      } else {
        onRefresh()
      }
    } finally {
      setResettingQuota(false)
    }
  }

  async function toggleBooleanSetting(
    field: 'studioLowMemoryChromeFlags' | 'studioDisableDevShmUsage' | 'studioAttachMovieFromDrive',
    nextVal: boolean,
  ) {
    if (field === 'studioLowMemoryChromeFlags') setLowMemoryChromeFlags(nextVal)
    if (field === 'studioDisableDevShmUsage') setDisableDevShmUsage(nextVal)
    if (field === 'studioAttachMovieFromDrive') setAttachMovieFromDrive(nextVal)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studio: {
          [field]: nextVal,
        },
      }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to update Studio toggle')
      return
    }
    onRefresh()
  }

  async function saveCookies() {
    if (!cookieText.trim()) return
    setSavingCookies(true)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ googleCookies: cookieText }),
    })
    setSavingCookies(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to save Google cookies')
      return
    }
    setCookieText('')
    onRefresh()
  }

  async function clearCookies() {
    setSavingCookies(true)
    setError(null)
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearGoogleCookies: true }),
    })
    setSavingCookies(false)
    setLoginTestResult(null)
    onRefresh()
  }

  async function runLoginTest() {
    setTestingLogin(true)
    setError(null)
    setLoginTestResult(null)
    try {
      const res = await fetch('/api/studio/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test_login' }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setError(data.error || 'Login test failed')
      } else {
        setLoginTestResult({
          loggedIn: Boolean(data.loggedIn),
          email: data.email,
          message: data.message,
        })
      }
      onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTestingLogin(false)
    }
  }

  async function connectDrive() {
    setConnectingDrive(true)
    setError(null)
    try {
      const res = await fetch('/api/drive/auth')
      const data = await res.json()
      if (!res.ok || !data.url) {
        setError(data.error || 'Failed to build Google Drive OAuth URL')
        setShowOAuthGuide(true)
        return
      }
      window.location.href = data.url
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnectingDrive(false)
    }
  }

  async function disconnectDrive() {
    await fetch('/api/drive/auth', { method: 'DELETE' })
    onRefresh()
  }

  return (
    <div className="mb-6 rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-4">
      {/* 1. Chunk Scan Engine Selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Cpu className="size-4 text-primary" />
          <div>
            <h2 className="text-sm font-semibold">Chunk scan engine</h2>
            <p className="text-xs text-muted-foreground">
              Choose how movie chunks are sent to Gemini (Verifier, Minute Finder & Render stay A-to-Z identical).
            </p>
          </div>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-background p-1">
          <button
            type="button"
            onClick={() => switchEngine('api')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              engine === 'api'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            API (old)
          </button>
          <button
            type="button"
            onClick={() => switchEngine('studio')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              engine === 'studio'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Gemini Studio (cookies)
          </button>
        </div>
      </div>

      {/* 2. Studio Settings (Cookies, Test Login, Model/Window Config, Google Drive OAuth) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-2 border-t border-border/60">
        {/* Left column: Google Cookies + Test Login + Google Drive OAuth */}
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-card/80 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <Cookie className="size-4 text-amber-400" />
                <span className="text-xs font-semibold">Google cookies (AI Studio session)</span>
              </div>
              {studio?.hasCookies ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] text-emerald-400">
                  <ShieldCheck className="size-3" />
                  {studio.cookieCount} cookies encrypted
                </span>
              ) : (
                <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] text-destructive">
                  not set
                </span>
              )}
            </div>

            <textarea
              value={cookieText}
              onChange={(e) => setCookieText(e.target.value)}
              rows={3}
              placeholder={
                studio?.hasCookies
                  ? 'Cookies stored encrypted on server (never returned). Paste new Cookie-Editor JSON or Playwright storageState to replace...'
                  : 'Paste JSON exported from Cookie-Editor ([...]) or Playwright storageState ({"cookies":[...]})'
              }
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
            />

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={saveCookies}
                disabled={savingCookies || !cookieText.trim()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
              >
                {savingCookies ? 'Encrypting...' : studio?.hasCookies ? 'Replace Cookies' : 'Save Encrypted'}
              </button>

              <button
                type="button"
                onClick={runLoginTest}
                disabled={testingLogin || !studio?.hasCookies}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
              >
                {testingLogin ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Testing aistudio.google.com...
                  </>
                ) : (
                  <>
                    <Sparkles className="size-3.5" />
                    Test login
                  </>
                )}
              </button>

              {studio?.hasCookies && (
                <button
                  type="button"
                  onClick={clearCookies}
                  disabled={savingCookies}
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:text-destructive"
                  title="Delete stored cookies"
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>

            {(loginTestResult || studio?.lastLoginStatus !== 'untested') && (
              <div
                className={`rounded-md border px-2.5 py-1.5 text-xs ${
                  (loginTestResult ? loginTestResult.loggedIn : studio?.lastLoginStatus === 'logged_in')
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                }`}
              >
                {loginTestResult ? (
                  <span>
                    {loginTestResult.loggedIn ? '✓ Logged IN' : '✗ Logged OUT'} — {loginTestResult.message}
                  </span>
                ) : (
                  <span>
                    Last test: {studio?.lastLoginStatus === 'logged_in' ? '✓ Logged IN' : '✗ Logged OUT'}
                    {studio?.lastLoginEmail ? ` (${studio.lastLoginEmail})` : ''}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Google Drive OAuth (drive.file scope) */}
          <div className="rounded-lg border border-border bg-card/80 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <CloudUpload className="size-4 text-sky-400" />
                <span className="text-xs font-semibold">Google Drive (&ldquo;CMT&rdquo; folder auto-upload)</span>
              </div>
              {studio?.driveConnected ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] text-emerald-400">
                  <Check className="size-3" />
                  {studio.driveConnectedEmail || 'Drive Connected'}
                </span>
              ) : (
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                  not connected
                </span>
              )}
            </div>

            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Uploads <code className="text-foreground">movie_360p.mp4</code> once to your Drive folder{' '}
              <code className="text-foreground">&ldquo;CMT&rdquo;</code> via resumable upload (scope:{' '}
              <code className="text-foreground">drive.file</code>, refresh token stored encrypted).
            </p>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={connectDrive}
                disabled={connectingDrive}
                className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                <ExternalLink className="size-3.5" />
                {studio?.driveConnected ? 'Reconnect Drive' : 'Connect Drive'}
              </button>

              {studio?.driveConnected && (
                <button
                  type="button"
                  onClick={disconnectDrive}
                  className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-destructive"
                >
                  Disconnect
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowOAuthGuide((v) => !v)}
                className="ml-auto inline-flex items-center gap-1 text-xs text-sky-400 hover:underline"
              >
                <HelpCircle className="size-3.5" />
                {showOAuthGuide ? 'Hide OAuth steps' : 'OAuth setup steps'}
              </button>
            </div>

            {showOAuthGuide && (
              <div className="mt-2 rounded-md border border-border/80 bg-background/90 p-2.5 text-[11px] leading-relaxed text-muted-foreground space-y-1">
                <p className="font-semibold text-foreground">How to create Google Drive OAuth Client:</p>
                <ol className="list-decimal pl-4 space-y-1">
                  <li>
                    Open <strong>Google Cloud Console → APIs &amp; Services → Library</strong> and enable{' '}
                    <strong>Google Drive API</strong>.
                  </li>
                  <li>
                    Go to <strong>OAuth consent screen</strong>, choose <strong>External</strong>, add scope{' '}
                    <code>.../auth/drive.file</code> and <code>.../auth/userinfo.email</code>, and add your Google
                    account under <strong>Test users</strong>.
                  </li>
                  <li>
                    Go to <strong>Credentials → Create Credentials → OAuth client ID</strong> (Application type:{' '}
                    <strong>Web application</strong>).
                  </li>
                  <li>
                    Add Authorized redirect URI:{' '}
                    <code className="text-foreground">
                      {typeof window !== 'undefined'
                        ? `${window.location.origin}/api/drive/callback`
                        : 'https://<your-domain>/api/drive/callback'}
                    </code>
                  </li>
                  <li>
                    Put <code>GOOGLE_OAUTH_CLIENT_ID</code>, <code>GOOGLE_OAUTH_CLIENT_SECRET</code>, and{' '}
                    <code>GOOGLE_OAUTH_REDIRECT_URI</code> in your <code>.env</code> and restart the container.
                  </li>
                </ol>
              </div>
            )}
          </div>
        </div>

        {/* Right column: Model name, Max output tokens, Window minutes, Short part minutes, Overlap */}
        <div className="rounded-lg border border-border bg-card/80 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">Studio Window &amp; Model Parameters</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              Offset calibration: <strong className="text-foreground">{offsetMode}</strong>
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Model (AI Studio picker)</span>
              <select
                value={
                  STUDIO_MODEL_DROPDOWN_OPTIONS.includes(
                    modelName as (typeof STUDIO_MODEL_DROPDOWN_OPTIONS)[number],
                  )
                    ? modelName
                    : 'Argon'
                }
                onChange={(e) => setModelName(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              >
                {STUDIO_MODEL_DROPDOWN_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Thinking level (default High)</span>
              <select
                value={thinkingLevel}
                onChange={(e) => setThinkingLevel(e.target.value as StudioThinkingLevel)}
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>

            {studio?.studioExhaustedModels &&
              Object.keys(studio.studioExhaustedModels).length > 0 && (
                <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
                  <div className="flex flex-wrap items-center gap-2">
                    {Object.entries(studio.studioExhaustedModels).map(([mName, untilTs]) => {
                      const localTimeStr = new Date(untilTs).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                      return (
                        <span key={mName} className="font-mono">
                          {mName} quota khatam, {localTimeStr} par wapas
                        </span>
                      )
                    })}
                    {studio.studioEffectiveModelName &&
                      studio.studioEffectiveModelName !== studio.studioModelName && (
                        <span className="text-muted-foreground">
                          (Effective: <strong className="text-foreground">{studio.studioEffectiveModelName}</strong>)
                        </span>
                      )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void resetExhaustedQuota(null)}
                    disabled={resettingQuota}
                    className="rounded border border-amber-500/50 bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
                  >
                    {resettingQuota ? 'Resetting...' : 'Reset'}
                  </button>
                </div>
              )}

            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Max output tokens</span>
              <input
                type="number"
                min={1024}
                max={65536}
                step={1024}
                value={maxOutputTokens}
                onChange={(e) => setMaxOutputTokens(Number(e.target.value))}
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">
                Max input tokens (auto = {(1_048_576 - (Number(maxOutputTokens) || 65536) - 5_000).toLocaleString()})
              </span>
              <input
                type="text"
                value={maxInputTokensStr}
                onChange={(e) => setMaxInputTokensStr(e.target.value)}
                placeholder={`auto (${1_048_576 - (Number(maxOutputTokens) || 65536) - 5_000})`}
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Window minutes (default 5)</span>
              <input
                type="number"
                min={1}
                max={15}
                value={windowMinutes}
                onChange={(e) => setWindowMinutes(Number(e.target.value))}
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Short part minutes (default 3)</span>
              <input
                type="number"
                min={1}
                max={10}
                value={shortPartMinutes}
                onChange={(e) => setShortPartMinutes(Number(e.target.value))}
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Window overlap sec (default 0)</span>
              <input
                type="number"
                min={0}
                max={60}
                value={windowOverlapSec}
                onChange={(e) => setWindowOverlapSec(Number(e.target.value))}
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Page recycle interval (jobs, default 5)</span>
              <input
                type="number"
                min={1}
                max={100}
                value={pageRecycleInterval}
                onChange={(e) => setPageRecycleInterval(Number(e.target.value))}
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          </div>

          {/* Chrome A/B Flags & Google Drive Movie Attach Toggles */}
          <div className="rounded-md border border-border/70 bg-background/60 p-2.5 space-y-2">
            <div className="text-[11px] font-semibold text-foreground">
              Chrome Launch Flags (A/B) &amp; Movie Attachment Mode
            </div>

            <label className="flex items-start justify-between gap-2 text-xs cursor-pointer">
              <div className="space-y-0.5">
                <span className="font-medium text-foreground">Low-memory Chrome flags (default OFF)</span>
                <p className="text-[10px] font-mono text-muted-foreground">
                  --disable-gpu · --disable-extensions · --disable-background-networking
                </p>
              </div>
              <input
                type="checkbox"
                checked={lowMemoryChromeFlags}
                onChange={(e) => void toggleBooleanSetting('studioLowMemoryChromeFlags', e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary cursor-pointer"
              />
            </label>

            <label className="flex items-start justify-between gap-2 text-xs cursor-pointer">
              <div className="space-y-0.5">
                <span className="font-medium text-foreground">--disable-dev-shm-usage (default ON)</span>
                <p className="text-[10px] font-mono text-muted-foreground">
                  Uses /tmp instead of /dev/shm for shared memory buffers
                </p>
              </div>
              <input
                type="checkbox"
                checked={disableDevShmUsage}
                onChange={(e) => void toggleBooleanSetting('studioDisableDevShmUsage', e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary cursor-pointer"
              />
            </label>

            <label className="flex items-start justify-between gap-2 text-xs cursor-pointer">
              <div className="space-y-0.5">
                <span className="font-medium text-foreground">Attach movie from Google Drive (default OFF)</span>
                <p className="text-[10px] text-muted-foreground">
                  Uploads <code className="font-mono">movie_360p.mp4</code> once to Drive folder &ldquo;CMT&rdquo; and attaches via Drive Picker so browser workers don&apos;t upload 378 MB locally
                </p>
              </div>
              <input
                type="checkbox"
                checked={attachMovieFromDrive}
                onChange={(e) => void toggleBooleanSetting('studioAttachMovieFromDrive', e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary cursor-pointer"
              />
            </label>
          </div>

          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] text-muted-foreground">
              Temp = 0 · Thinking = {thinkingLevel === 'medium' ? 'Medium' : thinkingLevel === 'low' ? 'Low' : 'High'} · Safety = OFF · 24 FPS
            </span>
            <button
              type="button"
              onClick={saveStudioParams}
              disabled={savingConfig}
              className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
            >
              {savingConfig ? 'Saving...' : configSaved ? '✓ Saved' : 'Save Studio Settings'}
            </button>
          </div>
        </div>
      </div>

      {error && <p className="text-xs text-destructive font-medium">{error}</p>}
    </div>
  )
}
