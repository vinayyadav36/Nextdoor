import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useSignUp } from '@clerk/react/legacy'
import { APP_CONFIG } from '@/config'

export default function Register() {
  const navigate = useNavigate()
  const { signUp, isLoaded, setActive } = useSignUp()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [step, setStep] = useState<'email' | 'otp'>('email')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (!isLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-55">
        <p className="text-sm font-semibold text-slate-500">Loading auth system…</p>
      </div>
    )
  }

  async function handleRequestOtp(e: React.FormEvent) {
    e.preventDefault()
    if (!signUp) return
    setError('')
    setLoading(true)
    try {
      const parts = name.trim().split(' ')
      const firstName = parts[0] || 'User'
      const lastName = parts.slice(1).join(' ') || ''

      // Generate a strong dummy password to satisfy password requirements on the Clerk instance
      const dummyPassword = `NextdoorPass99!_${Math.random().toString(36).slice(2)}`

      await signUp.create({
        emailAddress: email.trim(),
        password: dummyPassword,
        firstName,
        lastName,
      })

      await signUp.prepareVerification({ strategy: 'email_code' })
      setStep('otp')
    } catch (err: any) {
      setError(err.errors?.[0]?.message || err.message || 'Failed to request OTP')
    } finally {
      setLoading(false)
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault()
    if (!signUp || !setActive) return
    setError('')
    setLoading(true)
    try {
      const result = await signUp.attemptVerification({
        strategy: 'email_code',
        code: otp.trim(),
      })

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId })
        // Clerk session will automatically trigger the App.tsx SessionBootstrap component 
        // to sync the user info with the local backend and set local session tokens!
        navigate('/home', { replace: true })
      } else {
        const missing = result.missingFields ? result.missingFields.join(', ') : 'unknown'
        setError(`Sign up incomplete (Status: ${result.status}, Missing: ${missing}). Please try again.`)
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.message || err.message || 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-55 px-5 py-10">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold text-slate-900">Join {APP_CONFIG.appName}</h1>
        <p className="text-sm text-slate-500">Connect with your neighborhood.</p>
      </div>

      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-md border border-slate-100">
        {step === 'email' ? (
          <form onSubmit={handleRequestOtp} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700" htmlFor="name">
                Full Name
              </label>
              <input
                id="name"
                type="text"
                required
                className="input"
                placeholder="SALTEDHASH"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700" htmlFor="email">
                Email Address
              </label>
              <input
                id="email"
                type="email"
                required
                className="input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-600" role="alert">
                {error}
              </p>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? 'Sending OTP…' : 'Continue'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <div className="rounded border border-indigo-100 bg-indigo-50/50 p-2.5 text-xs text-indigo-800 leading-normal">
              📧 We have Securely dispatched Your  verification code to <strong>{email}</strong>. Please check your inbox.
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700" htmlFor="otp">
                Enter 6-digit OTP sent to {email}
              </label>
              <input
                id="otp"
                type="text"
                required
                maxLength={6}
                className="input text-center text-2xl tracking-[0.5em]"
                placeholder="000000"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </div>

            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-600" role="alert">
                {error}
              </p>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? 'Verifying…' : 'Create Account'}
            </button>

            <button
              type="button"
              className="mt-2 w-full text-sm text-slate-500 hover:text-slate-800"
              onClick={() => {
                setStep('email')
                setOtp('')
                setError('')
              }}
            >
              Change Email / Details
            </button>
          </form>
        )}
        {/* Clerk bot-protection CAPTCHA widget (must exist in DOM at all times) */}
        <div id="clerk-captcha" />
      </div>

      <p className="mt-6 text-sm text-slate-600">
        Already have an account?{' '}
        <Link to="/login" className="font-semibold text-primary">
          Sign In
        </Link>
      </p>
    </div>
  )
}
