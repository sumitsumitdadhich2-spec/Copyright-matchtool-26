import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/users'
import { getScan } from '@/lib/store'
import {
  buildParallelScanPdfBuffer,
  type ParallelPdfMode,
  type ParallelPdfRunScope,
} from '@/lib/studio-parallel-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })
  }

  const scanId = (req.nextUrl.searchParams.get('scanId') || '').trim()
  if (!scanId) {
    return NextResponse.json({ ok: false, error: 'Missing required scanId query parameter' }, { status: 400 })
  }

  const scan = scanId !== 'default' ? getScan(scanId) : null
  if (scan && session.role !== 'admin' && scan.ownerUsername && scan.ownerUsername !== session.username) {
    return NextResponse.json({ ok: false, error: 'Forbidden: scan belongs to another user' }, { status: 403 })
  }

  const rawMode = (req.nextUrl.searchParams.get('mode') || 'full').toLowerCase()
  const mode: ParallelPdfMode = rawMode === 'errors' ? 'errors' : 'full'
  const rawScope = (req.nextUrl.searchParams.get('runScope') || 'latest').toLowerCase()
  const runScope: ParallelPdfRunScope = rawScope === 'all' ? 'all' : 'latest'

  try {
    const { buffer, filename } = await buildParallelScanPdfBuffer({ scanId, mode, runScope })
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, max-age=0',
      },
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
