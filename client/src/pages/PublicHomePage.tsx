import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'

export default function PublicHomePage() {
  const navigate = useNavigate()
  const { data } = useQuery<{ role: 'admin' | 'user' | null }>({
    queryKey: ['auth-status'],
  })

  const start = () => {
    navigate(
      data?.role === 'admin'
        ? '/models/chat'
        : data?.role === 'user'
          ? '/user-center'
          : '/login',
    )
  }

  return (
    <>
      <style>{`
        @keyframes home-copy-enter {
          from {
            opacity: 0;
            transform: perspective(1000px) translateY(38px) translateZ(-120px) rotateX(18deg) scale(.94);
            filter: blur(16px);
          }
          to {
            opacity: 1;
            transform: perspective(1000px) translateY(0) translateZ(0) rotateX(0) scale(1);
            filter: blur(0);
          }
        }

        @keyframes home-actions-enter {
          from {
            opacity: 0;
            transform: perspective(900px) translateY(40px) translateZ(-80px) rotateX(14deg);
            filter: blur(8px);
          }
          to {
            opacity: 1;
            transform: perspective(900px) translateY(0) translateZ(0) rotateX(0);
            filter: blur(0);
          }
        }

        @keyframes home-video-drift {
          0%, 100% {
            transform: translate3d(-3%, -1.5%, 0) scale(1.12);
          }
          50% {
            transform: translate3d(3%, 1.5%, 0) scale(1.18);
          }
        }

        .home-copy-enter {
          animation: home-copy-enter 1.1s cubic-bezier(.22, 1, .36, 1) both;
        }

        .home-actions-enter {
          animation: home-actions-enter .9s .45s cubic-bezier(.22, 1, .36, 1) both;
        }

        .home-video-drift {
          animation: home-video-drift 8s cubic-bezier(.45, 0, .55, 1) infinite;
          backface-visibility: hidden;
          transform-origin: center;
          will-change: transform;
        }

        @media (prefers-reduced-motion: reduce) {
          .home-copy-enter,
          .home-actions-enter,
          .home-video-drift {
            animation: none;
          }
        }
      `}</style>

      <section className="relative left-1/2 -my-8 min-h-[calc(100vh-4.5rem)] w-screen -translate-x-1/2 overflow-hidden bg-black text-white">
        <video
          className="home-video-drift absolute inset-0 h-full w-full object-cover"
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          aria-hidden="true"
        >
          <source src="/media/tuoke-cosmos-4k120-v3.mp4" type="video/mp4" />
        </video>

        <div className="pointer-events-none absolute inset-0 bg-black/60" />
        <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_180px_80px_rgba(0,0,0,.72)]" />

        <div className="relative z-10 flex min-h-[calc(100vh-4.5rem)] items-center justify-center px-6 py-24 text-center">
          <div className="max-w-4xl">
            <div className="home-copy-enter">
              <p className="mb-6 text-xs font-medium uppercase tracking-[0.42em] text-white/65 sm:text-sm">
                Unified AI Infrastructure
              </p>

              <h1 className="text-6xl font-semibold tracking-[-0.05em] text-white drop-shadow-[0_0_28px_rgba(255,255,255,.25)] sm:text-7xl lg:text-8xl">
                Tuoke API
              </h1>

              <h2 className="mt-7 text-2xl font-medium tracking-tight text-white/95 sm:text-3xl lg:text-4xl">
                下一代 AI 模型聚合 API 平台
              </h2>

              <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-white/65 sm:text-lg">
                支持多个大模型调用。一个接口，连接领先的 AI 能力。
              </p>
            </div>

            <div className="home-actions-enter mt-10 flex flex-wrap items-center justify-center gap-4">
              <Button
                size="lg"
                className="min-w-36 rounded-full bg-white px-8 text-black shadow-[0_0_35px_rgba(255,255,255,.18)] transition duration-300 hover:scale-[1.03] hover:bg-white/90"
                onClick={start}
              >
                开始使用
              </Button>

              <Link to="/user-models">
                <Button
                  size="lg"
                  variant="outline"
                  className="min-w-36 rounded-full border-white/30 bg-black/20 px-8 text-white backdrop-blur-md transition duration-300 hover:scale-[1.03] hover:border-white/55 hover:bg-white/10 hover:text-white"
                >
                  查看模型
                </Button>
              </Link>
            </div>
          </div>
        </div>

        <div className="pointer-events-none absolute bottom-7 left-1/2 z-10 -translate-x-1/2 text-[10px] uppercase tracking-[0.35em] text-white/35">
          Explore the intelligence
        </div>
      </section>
    </>
  )
}
