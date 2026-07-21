import { useEffect, useRef, type CSSProperties } from 'react'

import './Waves.css'

type WavesProps = {
  lineColor?: string
  backgroundColor?: string
  waveSpeedX?: number
  waveSpeedY?: number
  waveAmpX?: number
  waveAmpY?: number
  friction?: number
  tension?: number
  maxCursorMove?: number
  xGap?: number
  yGap?: number
  className?: string
  style?: CSSProperties
}

type Point = {
  x: number
  y: number
  wave: { x: number; y: number }
  cursor: { x: number; y: number; vx: number; vy: number }
}

type MouseState = {
  x: number
  y: number
  lx: number
  ly: number
  sx: number
  sy: number
  vs: number
  a: number
  set: boolean
}

const permutation = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225,
  140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148,
  247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32,
  57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175,
  74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122,
  60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54,
  65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169,
  200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3,
  64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85,
  212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170,
  213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43,
  172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185,
  112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191,
  179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31,
  181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150,
  254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195,
  78, 66, 215, 61, 156, 180,
]

const gradients = [
  [1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0],
  [1, 0], [-1, 0], [0, 1], [0, -1], [0, 1], [0, -1],
] as const

class Noise {
  private perm = new Array<number>(512)
  private grad = new Array<(typeof gradients)[number]>(512)

  constructor(seed: number) {
    let value = Math.floor(seed * 65536)
    if (value < 256) value |= value << 8

    for (let index = 0; index < 256; index += 1) {
      const mixed = index & 1
        ? permutation[index] ^ (value & 255)
        : permutation[index] ^ ((value >> 8) & 255)
      this.perm[index] = this.perm[index + 256] = mixed
      this.grad[index] = this.grad[index + 256] = gradients[mixed % 12]
    }
  }

  perlin2(inputX: number, inputY: number) {
    let cellX = Math.floor(inputX)
    let cellY = Math.floor(inputY)
    const x = inputX - cellX
    const y = inputY - cellY
    cellX &= 255
    cellY &= 255

    const dot = (gradient: (typeof gradients)[number], px: number, py: number) =>
      gradient[0] * px + gradient[1] * py
    const fade = (amount: number) => amount ** 3 * (amount * (amount * 6 - 15) + 10)
    const lerp = (start: number, end: number, amount: number) =>
      start + (end - start) * amount

    const n00 = dot(this.grad[cellX + this.perm[cellY]], x, y)
    const n01 = dot(this.grad[cellX + this.perm[cellY + 1]], x, y - 1)
    const n10 = dot(this.grad[cellX + 1 + this.perm[cellY]], x - 1, y)
    const n11 = dot(this.grad[cellX + 1 + this.perm[cellY + 1]], x - 1, y - 1)
    return lerp(lerp(n00, n10, fade(x)), lerp(n01, n11, fade(x)), fade(y))
  }
}

export default function Waves({
  lineColor = 'rgba(255, 255, 255, 0.28)',
  backgroundColor = 'transparent',
  waveSpeedX = 0.0125,
  waveSpeedY = 0.006,
  waveAmpX = 32,
  waveAmpY = 14,
  friction = 0.92,
  tension = 0.008,
  maxCursorMove = 80,
  xGap = 14,
  yGap = 38,
  className = '',
  style,
}: WavesProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!container || !canvas || !context) return

    const noise = new Noise(Math.random())
    const mouse: MouseState = {
      x: -100,
      y: -100,
      lx: -100,
      ly: -100,
      sx: -100,
      sy: -100,
      vs: 0,
      a: 0,
      set: false,
    }
    let width = 0
    let height = 0
    let lines: Point[][] = []
    let frameId = 0
    let visible = true

    const createLines = () => {
      lines = []
      const totalLines = Math.ceil((width + 200) / xGap)
      const totalPoints = Math.ceil((height + 30) / yGap)
      const startX = (width - xGap * totalLines) / 2
      const startY = (height - yGap * totalPoints) / 2

      for (let column = 0; column <= totalLines; column += 1) {
        const points: Point[] = []
        for (let row = 0; row <= totalPoints; row += 1) {
          points.push({
            x: startX + xGap * column,
            y: startY + yGap * row,
            wave: { x: 0, y: 0 },
            cursor: { x: 0, y: 0, vx: 0, vy: 0 },
          })
        }
        lines.push(points)
      }
    }

    const resize = () => {
      const bounds = container.getBoundingClientRect()
      width = bounds.width
      height = bounds.height
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      createLines()
    }

    const updateMouse = (clientX: number, clientY: number) => {
      const bounds = container.getBoundingClientRect()
      if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) return
      mouse.x = clientX - bounds.left
      mouse.y = clientY - bounds.top
      if (!mouse.set) {
        mouse.sx = mouse.lx = mouse.x
        mouse.sy = mouse.ly = mouse.y
        mouse.set = true
      }
    }

    const movePoints = (time: number) => {
      for (const points of lines) {
        for (const point of points) {
          const movement = noise.perlin2(
            (point.x + time * waveSpeedX) * 0.002,
            (point.y + time * waveSpeedY) * 0.0015,
          ) * 12
          point.wave.x = Math.cos(movement) * waveAmpX
          point.wave.y = Math.sin(movement) * waveAmpY

          const dx = point.x - mouse.sx
          const dy = point.y - mouse.sy
          const distance = Math.hypot(dx, dy)
          const radius = Math.max(175, mouse.vs)
          if (mouse.set && distance < radius) {
            const strength = 1 - distance / radius
            const force = Math.cos(distance * 0.001) * strength
            point.cursor.vx += Math.cos(mouse.a) * force * radius * mouse.vs * 0.00065
            point.cursor.vy += Math.sin(mouse.a) * force * radius * mouse.vs * 0.00065
          }

          point.cursor.vx = (point.cursor.vx - point.cursor.x * tension) * friction
          point.cursor.vy = (point.cursor.vy - point.cursor.y * tension) * friction
          point.cursor.x = Math.max(-maxCursorMove, Math.min(maxCursorMove, point.cursor.x + point.cursor.vx * 2))
          point.cursor.y = Math.max(-maxCursorMove, Math.min(maxCursorMove, point.cursor.y + point.cursor.vy * 2))
        }
      }
    }

    const draw = () => {
      context.clearRect(0, 0, width, height)
      context.beginPath()
      context.strokeStyle = lineColor
      context.lineWidth = 1

      for (const points of lines) {
        points.forEach((point, index) => {
          const includeCursor = index !== points.length - 1
          const x = point.x + point.wave.x + (includeCursor ? point.cursor.x : 0)
          const y = point.y + point.wave.y + (includeCursor ? point.cursor.y : 0)
          if (index === 0) context.moveTo(x, y)
          else context.lineTo(x, y)
        })
      }
      context.stroke()
    }

    const tick = (time: number) => {
      mouse.sx += (mouse.x - mouse.sx) * 0.1
      mouse.sy += (mouse.y - mouse.sy) * 0.1
      const dx = mouse.x - mouse.lx
      const dy = mouse.y - mouse.ly
      const speed = Math.hypot(dx, dy)
      mouse.vs = Math.min(100, mouse.vs + (speed - mouse.vs) * 0.1)
      mouse.lx = mouse.x
      mouse.ly = mouse.y
      mouse.a = Math.atan2(dy, dx)

      movePoints(time)
      draw()
      if (visible) frameId = requestAnimationFrame(tick)
    }

    const resizeObserver = new ResizeObserver(resize)
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      const nextVisible = entry.isIntersecting
      if (nextVisible && !visible) {
        visible = true
        frameId = requestAnimationFrame(tick)
      } else if (!nextVisible && visible) {
        visible = false
        cancelAnimationFrame(frameId)
      }
    })
    const onPointerMove = (event: PointerEvent) => updateMouse(event.clientX, event.clientY)

    resize()
    resizeObserver.observe(container)
    visibilityObserver.observe(container)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    frameId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      visibilityObserver.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
    }
  }, [friction, lineColor, maxCursorMove, tension, waveAmpX, waveAmpY, waveSpeedX, waveSpeedY, xGap, yGap])

  return (
    <div
      ref={containerRef}
      className={`waves ${className}`}
      style={{ backgroundColor, ...style }}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="waves-canvas" />
    </div>
  )
}
