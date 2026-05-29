import { Suspense } from 'react'
import { OnboardingPage } from '@/components/cortex/live/pages'

export default function Page() {
  return (
    <Suspense fallback={<main className="p-6 text-muted-foreground">Loading onboarding...</main>}>
      <OnboardingPage />
    </Suspense>
  )
}
