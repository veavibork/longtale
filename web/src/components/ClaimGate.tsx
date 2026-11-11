import { useState } from 'react'
import { claimSession, getStoredUserName, type SupersededInfo, type SupersededReason } from '../api'
import { formatRelativeTime } from '../lib/format-time'
import './ClaimGate.css'

export type GateReason = 'no-session' | SupersededReason

interface ClaimGateProps {
  reason: GateReason
  info: SupersededInfo | null
  onClaimed: () => void
}

export default function ClaimGate({ reason, info, onClaimed }: ClaimGateProps) {
  const superseded = reason === 'superseded'
  const expired = reason === 'expired'
  const [displayName, setDisplayName] = useState(
    superseded || expired ? (getStoredUserName() ?? '') : '',
  )
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)

  async function handleClaim(e: React.FormEvent) {
    e.preventDefault()
    setClaiming(true)
    setError(null)
    try {
      await claimSession(displayName.trim(), password)
      onClaimed()
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
      setClaiming(false)
    }
  }

  return (
    <div className="claim-gate">
      <div className="claim-gate-card">
        <h1>Longtale</h1>
        {superseded ? (
          <>
            <p className="claim-gate-message">
              This session was superseded — another session took over the platform.
            </p>
            <div className="claim-gate-timestamps">
              {info?.stale && (
                <div>
                  Last interaction on your session: {formatRelativeTime(info.stale.lastSeenAt)}
                </div>
              )}
              {info?.active && (
                <div>
                  Last interaction on the active session:{' '}
                  {formatRelativeTime(info.active.lastSeenAt)}
                </div>
              )}
            </div>
          </>
        ) : expired ? (
          <p className="claim-gate-message">
            Your session expired after 30 days without activity. Log in again to continue.
          </p>
        ) : (
          <p className="claim-gate-message">
            This platform hasn't been claimed by this browser yet.
          </p>
        )}
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={handleClaim}>
          <input
            type="text"
            className="claim-gate-input"
            placeholder="Name"
            autoComplete="username"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoFocus={!displayName}
          />
          <input
            type="password"
            className="claim-gate-input"
            placeholder="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus={!!displayName}
          />
          <button type="submit" disabled={claiming || !displayName.trim() || !password}>
            {claiming ? 'Claiming…' : superseded ? 'Take over' : 'Claim'}
          </button>
        </form>
      </div>
    </div>
  )
}
