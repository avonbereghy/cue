/* ============================================================
   Cue — Marketing Website Interactions
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {

  /* ----------------------------------------------------------
     Signal Strings — Low-power canvas oscillating strings
     Optimized: 20fps cap, reduced segments, page visibility
     pause, single shared rAF loop, DPR capped at 1.5
     ---------------------------------------------------------- */

  const TARGET_FPS = 20;
  const FRAME_INTERVAL = 1000 / TARGET_FPS;
  const SEGMENTS = 40;
  const MAX_DPR = 1.5; // Cap pixel density — no visual difference at string opacity

  // Shared animation loop for ALL canvases — single rAF, not one per canvas
  const activeInstances = new Set();
  let sharedRaf = null;
  let lastFrameTime = 0;
  let pageVisible = true;

  function sharedLoop(ts) {
    sharedRaf = null;
    if (!pageVisible || activeInstances.size === 0) return;

    // Throttle to target FPS
    if (ts - lastFrameTime < FRAME_INTERVAL) {
      sharedRaf = requestAnimationFrame(sharedLoop);
      return;
    }
    lastFrameTime = ts;

    const now = ts / 1000;
    for (const inst of activeInstances) {
      inst.draw(now);
    }
    sharedRaf = requestAnimationFrame(sharedLoop);
  }

  function startSharedLoop() {
    if (sharedRaf === null && activeInstances.size > 0 && pageVisible) {
      sharedRaf = requestAnimationFrame(sharedLoop);
    }
  }

  function stopSharedLoop() {
    if (sharedRaf !== null) {
      cancelAnimationFrame(sharedRaf);
      sharedRaf = null;
    }
  }

  // Pause when tab is hidden
  document.addEventListener('visibilitychange', () => {
    pageVisible = !document.hidden;
    if (pageVisible) startSharedLoop();
    else stopSharedLoop();
  });

  class SignalStrings {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.strings = [];
      this.count = parseInt(canvas.dataset.strings || '8', 10);
      this.W = 0;
      this.H = 0;
      this.colors = [
        [168, 216, 234],
        [178, 228, 240],
        [200, 220, 240],
        [200, 240, 216],
        [250, 240, 192],
        [180, 210, 235],
      ];
      // Pre-compute color strings to avoid per-frame allocation
      this.colorCache = new Map();
      this.init();
    }

    init() {
      this.resize();
      this.resizeTimer = null;
      this.onResize = () => {
        // Debounce resize to avoid thrashing
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => this.resize(), 200);
      };
      window.addEventListener('resize', this.onResize);
      activeInstances.add(this);
      startSharedLoop();
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.W = rect.width;
      this.H = rect.height;
      this.buildStrings();
      // Pre-compute spatial envelope lookup (sin values for each segment)
      this.spatialLUT = new Float32Array(SEGMENTS + 1);
      for (let i = 0; i <= SEGMENTS; i++) {
        this.spatialLUT[i] = Math.sin((i / SEGMENTS) * Math.PI);
      }
    }

    buildStrings() {
      this.strings = Array.from({ length: this.count }, (_, i) => {
        const t = i / Math.max(this.count - 1, 1);
        const color = this.colors[i % this.colors.length];
        return {
          y0: this.H * 0.1 + t * this.H * 0.8,
          amplitude: 2 + Math.random() * 5,
          frequency: 0.3 + Math.random() * 1.0,
          phase: Math.random() * Math.PI * 2,
          // Only 2 harmonics instead of 3 — negligible visual difference
          h1Amp: 1.0,
          h1Phase: 0,
          h2Amp: 0.3 + Math.random() * 0.25,
          h2Phase: Math.random() * Math.PI,
          driftFreq: 0.06 + Math.random() * 0.1,
          driftPhase: Math.random() * Math.PI * 2,
          r: color[0], g: color[1], b: color[2],
          alpha: 0.45 + Math.random() * 0.3,
          width: 0.6 + Math.random() * 0.8,
        };
      });
    }

    draw(now) {
      const { ctx, W, H, strings, spatialLUT } = this;
      if (W === 0 || H === 0) return;
      ctx.clearRect(0, 0, W, H);

      const PI2 = Math.PI * 2;

      for (let si = 0; si < strings.length; si++) {
        const s = strings[si];

        // Breathing envelope — one sin per string per frame
        const envelope = 0.5 + 0.5 * Math.sin(now * s.driftFreq * PI2 + s.driftPhase);
        const ampScale = s.amplitude * (0.5 + 0.5 * envelope);
        const alpha = s.alpha * (0.5 + 0.5 * envelope);

        // Pre-compute harmonic time components (2 harmonics, not 3)
        const h1Time = s.frequency * now * PI2 + s.h1Phase + s.phase;
        const h2Time = 2.0 * s.frequency * now * PI2 + s.h2Phase + s.phase;

        ctx.beginPath();
        ctx.lineWidth = s.width;
        ctx.strokeStyle = `rgba(${s.r},${s.g},${s.b},${alpha.toFixed(2)})`;

        for (let i = 0; i <= SEGMENTS; i++) {
          const x = (i / SEGMENTS) * W;
          const spatial = spatialLUT[i];
          // Only 2 sin calls per segment (was 3)
          const displacement = Math.sin(h1Time) + s.h2Amp * Math.sin(h2Time);
          const y = s.y0 + spatial * displacement * ampScale;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    destroy() {
      activeInstances.delete(this);
      if (activeInstances.size === 0) stopSharedLoop();
      window.removeEventListener('resize', this.onResize);
      clearTimeout(this.resizeTimer);
    }
  }

  // Init signal strings (respect reduced motion)
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!prefersReduced) {
    document.querySelectorAll('.signal-strings-canvas').forEach(canvas => {
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.isIntersecting && !canvas._strings) {
            canvas._strings = new SignalStrings(canvas);
          } else if (!entry.isIntersecting && canvas._strings) {
            canvas._strings.destroy();
            canvas._strings = null;
          }
        }
      }, { threshold: 0.01 });
      observer.observe(canvas);
    });
  }

  /* ----------------------------------------------------------
     Scroll Reveal — IntersectionObserver
     ---------------------------------------------------------- */

  const revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length && !prefersReduced) {
    const revealObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      }
    }, { threshold: 0.15 });
    revealEls.forEach(el => revealObserver.observe(el));
  } else {
    revealEls.forEach(el => el.classList.add('is-visible'));
  }

  /* ----------------------------------------------------------
     Nav Scroll — add .scrolled class on scroll
     ---------------------------------------------------------- */

  const nav = document.querySelector('.nav');
  if (nav) {
    const onScroll = () => {
      nav.classList.toggle('scrolled', window.scrollY > 50);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ----------------------------------------------------------
     Active Nav Links — highlight based on scroll position
     ---------------------------------------------------------- */

  const navLinks = document.querySelectorAll('.nav-links a[href^="#"]');
  const sections = document.querySelectorAll('section[id]');
  if (navLinks.length && sections.length) {
    const linkObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          navLinks.forEach(link => {
            link.classList.toggle('active', link.getAttribute('href') === '#' + entry.target.id);
          });
        }
      }
    }, { rootMargin: '-30% 0px -70% 0px' });
    sections.forEach(s => linkObserver.observe(s));
  }

  /* ----------------------------------------------------------
     Mobile Nav — close on link click
     ---------------------------------------------------------- */

  const navToggle = document.getElementById('nav-toggle');
  const navMenu = document.getElementById('nav-links-list');
  if (navToggle && navMenu) {
    const closeMenu = () => {
      navToggle.setAttribute('aria-expanded', 'false');
      navMenu.classList.remove('is-open');
    };
    navToggle.addEventListener('click', () => {
      const expanded = navToggle.getAttribute('aria-expanded') === 'true';
      navToggle.setAttribute('aria-expanded', String(!expanded));
      navMenu.classList.toggle('is-open');
    });
    document.querySelectorAll('.nav-links a').forEach(link => {
      link.addEventListener('click', closeMenu);
    });
  }

  /* ----------------------------------------------------------
     Copy to Clipboard
     ---------------------------------------------------------- */

  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.dataset.copy;
      if (!text) return;

      const write = navigator.clipboard
        ? navigator.clipboard.writeText(text)
        : new Promise((resolve, reject) => {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try {
              document.execCommand('copy') ? resolve() : reject();
            } catch (e) { reject(e); }
            document.body.removeChild(ta);
          });

      write.then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      }).catch(() => {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      });
    });
  });

});
