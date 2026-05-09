import { saveProgress, getProgress, getSetting, setSetting } from './db.js';
import { loadSubtitleHandle, addTrack, clearTracks, disableAllTracks, enableTrack } from './subtitles.js';

const PROGRESS_SAVE_INTERVAL = 5000;

export class Player {
  constructor(opts) {
    this.video = document.getElementById('video-el');
    this.container = document.getElementById('video-container');
    this.overlay = document.getElementById('player-overlay');
    this.onEnded = opts.onEnded || (() => {});
    this.onBack = opts.onBack || (() => {});

    this._currentKey = null;
    this._currentBlobUrl = null;
    this._hideTimer = null;
    this._progressTimer = null;
    this._dragging = false;
    this._subtitleMenuOpen = false;
    this._castMode = false;
    this._remotePlayer = null;
    this._remoteController = null;
    this._rcHandlers = null;
    this._castHasPlayed = false;

    this._setupElements();
    this._bindEvents();
    this._restoreVolume();
  }

  _setupElements() {
    this.playPauseBtn = document.getElementById('play-pause-btn');
    this.playIcon = document.getElementById('play-icon');
    this.pauseIcon = document.getElementById('pause-icon');
    this.prevBtn = document.getElementById('prev-btn');
    this.nextBtn = document.getElementById('next-btn');
    this.muteBtn = document.getElementById('mute-btn');
    this.volHigh = document.getElementById('vol-high');
    this.volMuted = document.getElementById('vol-muted');
    this.volumeSlider = document.getElementById('volume-slider');
    this.progressBar = document.getElementById('progress-bar');
    this.bufferedFill = document.getElementById('buffered-fill');
    this.progressFill = document.getElementById('progress-fill');
    this.progressThumb = document.getElementById('progress-thumb');
    this.progressTooltip = document.getElementById('progress-tooltip');
    this.currentTimeEl = document.getElementById('current-time-el');
    this.durationEl = document.getElementById('duration-el');
    this.speedSelect = document.getElementById('speed-select');
    this.fullscreenBtn = document.getElementById('fullscreen-btn');
    this.fsExpand = document.getElementById('fs-expand');
    this.fsShrink = document.getElementById('fs-shrink');
    this.backBtn = document.getElementById('back-btn');
    this.titleEl = document.getElementById('player-title');
    this.subtitleBtn = document.getElementById('subtitle-btn');
    this.subtitleMenu = document.getElementById('subtitle-menu');
    this.subtitleTrackList = document.getElementById('subtitle-track-list');
    this.closeSubtitleMenu = document.getElementById('close-subtitle-menu');
    this.subFileInput = document.getElementById('sub-file-input');
    this.centerClick = document.getElementById('center-click');
    this.playIndicator = document.getElementById('play-indicator');
    this.togglePlaylistBtn = document.getElementById('toggle-playlist-btn');
    this.castBtnPlayer = document.getElementById('cast-btn-player');
  }

  _bindEvents() {
    this.playPauseBtn.addEventListener('click', () => this.togglePlay());
    this.centerClick.addEventListener('click', () => this.togglePlay());
    this.centerClick.addEventListener('dblclick', () => this.toggleFullscreen());

    this.prevBtn.addEventListener('click', () => this.onPrev?.());
    this.nextBtn.addEventListener('click', () => this.onEnded());

    this.muteBtn.addEventListener('click', () => this.toggleMute());
    this.volumeSlider.addEventListener('input', () => {
      if (this._castMode && this._remoteController) {
        this._remotePlayer.volumeLevel = parseFloat(this.volumeSlider.value);
        this._remoteController.setVolumeLevel();
        const muted = parseFloat(this.volumeSlider.value) === 0;
        this.volHigh.style.display = muted ? 'none' : '';
        this.volMuted.style.display = muted ? '' : 'none';
        return;
      }
      this.video.volume = parseFloat(this.volumeSlider.value);
      this.video.muted = this.video.volume === 0;
      this._updateVolumeUI();
      setSetting('volume', this.video.volume);
    });

    this.progressBar.addEventListener('mousedown', (e) => this._startSeek(e));
    this.progressBar.addEventListener('mousemove', (e) => this._onProgressHover(e));
    window.addEventListener('mousemove', (e) => { if (this._dragging) this._doSeek(e); });
    window.addEventListener('mouseup', (e) => { if (this._dragging) { this._doSeek(e); this._dragging = false; } });
    this.progressBar.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') this.seek(-5);
      if (e.key === 'ArrowRight') this.seek(5);
    });

    this.speedSelect.addEventListener('change', () => {
      const rate = parseFloat(this.speedSelect.value);
      if (this._castMode) {
        try {
          const session = cast.framework.CastContext.getInstance().getCurrentSession();
          const media = session?.getMediaSession();
          if (media) media.setPlaybackRate(new chrome.cast.media.PlaybackRateRequest(rate), null, null);
        } catch {}
        return;
      }
      this.video.playbackRate = rate;
    });

    this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => this._onFullscreenChange());

    this.backBtn.addEventListener('click', () => this.onBack());

    this.subtitleBtn.addEventListener('click', (e) => { e.stopPropagation(); this._toggleSubtitleMenu(); });
    this.closeSubtitleMenu.addEventListener('click', () => this._closeSubtitleMenu());
    this.subFileInput.addEventListener('change', (e) => this._loadExternalSub(e));
    document.addEventListener('click', (e) => {
      if (!this.subtitleMenu.contains(e.target) && e.target !== this.subtitleBtn) {
        this._closeSubtitleMenu();
      }
    });

    this.container.addEventListener('mousemove', () => this._showOverlay());
    this.container.addEventListener('mouseleave', () => this._scheduleHide());
    this.overlay.addEventListener('mouseenter', () => { clearTimeout(this._hideTimer); });
    this.overlay.addEventListener('mouseleave', () => this._scheduleHide());

    this.video.addEventListener('play', () => this._onPlay());
    this.video.addEventListener('pause', () => this._onPause());
    this.video.addEventListener('ended', () => this._onVideoEnded());
    this.video.addEventListener('timeupdate', () => this._onTimeUpdate());
    this.video.addEventListener('progress', () => this._onBufferUpdate());
    this.video.addEventListener('durationchange', () => {
      if (!this._castMode) this.durationEl.textContent = formatTime(this.video.duration);
    });
    this.video.addEventListener('loadedmetadata', () => {
      if (!this._castMode) this.durationEl.textContent = formatTime(this.video.duration);
    });
    this.video.addEventListener('error', () => {
      if (!this._currentBlobUrl) return;
      if (this._castMode) return;
      console.error('Video error', this.video.error);
      window.dispatchEvent(new CustomEvent('videoError', { detail: this.video.error }));
    });

    document.addEventListener('keydown', (e) => this._onKey(e));

    this.togglePlaylistBtn.addEventListener('click', () => {
      document.getElementById('playlist-sidebar').classList.toggle('hidden');
    });
    document.getElementById('close-playlist-btn').addEventListener('click', () => {
      document.getElementById('playlist-sidebar').classList.add('hidden');
    });
  }

  async _restoreVolume() {
    const vol = await getSetting('volume', 1);
    this.video.volume = vol;
    this.volumeSlider.value = vol;
    this._updateVolumeUI();
  }

  async load(videoEntry, autoplay = true) {
    if (this._currentBlobUrl) {
      URL.revokeObjectURL(this._currentBlobUrl);
      this._currentBlobUrl = null;
    }
    clearTracks(this.video);
    this.video.src = '';
    this._currentKey = videoEntry.key;

    const file = await videoEntry.handle.getFile();
    this._currentBlobUrl = URL.createObjectURL(file);
    this.video.src = this._currentBlobUrl;
    this.titleEl.textContent = videoEntry.baseName;
    if (this._castMode) {
      document.getElementById('cast-overlay-title').textContent = videoEntry.baseName;
    }

    for (const sub of videoEntry.subtitles) {
      await loadSubtitleHandle(sub.handle, this.video, sub.ext.toUpperCase());
    }

    if (videoEntry.subtitles.length > 0) {
      const subEnabled = await getSetting('subtitlesEnabled', true);
      if (subEnabled) {
        this.video.addEventListener('loadedmetadata', () => {
          const tracks = Array.from(this.video.textTracks);
          if (tracks.length > 0 && tracks.every(t => t.mode === 'disabled')) {
            tracks[0].mode = 'showing';
          }
        }, { once: true });
      }
    }

    this._renderSubtitleMenu();

    const prog = await getProgress(videoEntry.key);
    if (prog && prog.position > 10 && !prog.completed) {
      this.video.addEventListener('loadedmetadata', () => {
        this.video.currentTime = prog.position;
      }, { once: true });
    }

    if (!this._castMode) {
      this._startProgressSaving();
      if (autoplay) this.video.play().catch(() => {});
    }

    this._showOverlay();
  }

  // ─── Cast mode ────────────────────────────────────────────────────────────

  isCasting() { return this._castMode; }

  enterCastMode(deviceName) {
    this._castMode = true;
    this._castHasPlayed = false;
    this._stopProgressSaving();
    this.video.pause();
    this.video.style.display = 'none';

    document.getElementById('cast-overlay').style.display = '';
    document.getElementById('cast-device-label').textContent = deviceName || 'your TV';

    this._remotePlayer = new cast.framework.RemotePlayer();
    this._remoteController = new cast.framework.RemotePlayerController(this._remotePlayer);
    this._bindRemoteEvents();
    this.overlay.classList.add('always-visible');

    // Populate UI from current remote state — critical when rejoining after page refresh
    const castTitle = this._remotePlayer.title || this.titleEl.textContent;
    document.getElementById('cast-overlay-title').textContent = castTitle;
    if (this._remotePlayer.title) this.titleEl.textContent = this._remotePlayer.title;

    const dur = this._remotePlayer.duration;
    const cur = this._remotePlayer.currentTime;
    if (dur) {
      this.durationEl.textContent = formatTime(dur);
      if (cur) {
        const pct = (cur / dur) * 100;
        this.progressFill.style.width = `${pct}%`;
        this.progressThumb.style.left = `${pct}%`;
        this.currentTimeEl.textContent = formatTime(cur);
      }
    }
    const paused = this._remotePlayer.isPaused ?? true;
    this.playIcon.style.display = paused ? '' : 'none';
    this.pauseIcon.style.display = paused ? 'none' : '';
    if (this._remotePlayer.playerState === 'PLAYING') this._castHasPlayed = true;
  }

  exitCastMode() {
    const lastPosition = this._remotePlayer?.currentTime || 0;

    this._castMode = false;
    this._castHasPlayed = false;
    this._unbindRemoteEvents();
    this._remotePlayer = null;
    this._remoteController = null;

    this.video.style.display = '';
    document.getElementById('cast-overlay').style.display = 'none';
    this.overlay.classList.remove('always-visible');

    // Only resume local video if one is actually loaded
    if (this._currentBlobUrl) {
      if (lastPosition > 0) {
        const seek = () => { this.video.currentTime = lastPosition; };
        if (this.video.readyState >= 1) seek();
        else this.video.addEventListener('loadedmetadata', seek, { once: true });
      }
      this._startProgressSaving();
      this.video.play().catch(() => {});
    }
  }

  _bindRemoteEvents() {
    const RC = cast.framework.RemotePlayerEventType;
    this._rcHandlers = {
      [RC.CURRENT_TIME_CHANGED]: () => {
        if (!this._remotePlayer) return;
        const cur = this._remotePlayer.currentTime;
        const dur = this._remotePlayer.duration;
        if (!dur) return;
        const pct = (cur / dur) * 100;
        this.progressFill.style.width = `${pct}%`;
        this.progressThumb.style.left = `${pct}%`;
        this.currentTimeEl.textContent = formatTime(cur);
      },
      [RC.DURATION_CHANGED]: () => {
        this.durationEl.textContent = formatTime(this._remotePlayer?.duration || 0);
      },
      [RC.IS_PAUSED_CHANGED]: () => {
        const paused = this._remotePlayer?.isPaused ?? true;
        this.playIcon.style.display = paused ? '' : 'none';
        this.pauseIcon.style.display = paused ? 'none' : '';
      },
      [RC.VOLUME_LEVEL_CHANGED]: () => {
        if (this._remotePlayer) this.volumeSlider.value = this._remotePlayer.volumeLevel;
      },
      [RC.IS_MUTED_CHANGED]: () => {
        const muted = this._remotePlayer?.isMuted ?? false;
        this.volHigh.style.display = muted ? 'none' : '';
        this.volMuted.style.display = muted ? '' : 'none';
      },
      [RC.PLAYER_STATE_CHANGED]: () => {
        if (!this._remotePlayer) return;
        if (this._remotePlayer.playerState === 'PLAYING') this._castHasPlayed = true;
        if (this._remotePlayer.playerState === 'IDLE' && this._castHasPlayed) {
          this._castHasPlayed = false;
          this.onEnded();
        }
      },
    };
    for (const [event, handler] of Object.entries(this._rcHandlers)) {
      this._remoteController.addEventListener(event, handler);
    }
  }

  _unbindRemoteEvents() {
    if (!this._rcHandlers || !this._remoteController) return;
    for (const [event, handler] of Object.entries(this._rcHandlers)) {
      this._remoteController.removeEventListener(event, handler);
    }
    this._rcHandlers = null;
  }

  // ─── Public controls ─────────────────────────────────────────────────────

  togglePlay() {
    if (this._castMode && this._remoteController) {
      this._remoteController.playOrPause();
      return;
    }
    if (this.video.paused) {
      this.video.play().catch(() => {});
    } else {
      this.video.pause();
    }
    this._flashIndicator(this.video.paused);
  }

  seek(delta) {
    if (this._castMode && this._remotePlayer) {
      this._remotePlayer.currentTime = Math.max(0, Math.min(
        this._remotePlayer.duration || 0,
        this._remotePlayer.currentTime + delta
      ));
      this._remoteController.seek();
      return;
    }
    this.video.currentTime = Math.max(0, Math.min(this.video.duration, this.video.currentTime + delta));
  }

  seekTo(seconds) {
    if (this._castMode && this._remotePlayer) {
      this._remotePlayer.currentTime = Math.max(0, Math.min(this._remotePlayer.duration || 0, seconds));
      this._remoteController.seek();
      return;
    }
    this.video.currentTime = Math.max(0, Math.min(this.video.duration, seconds));
  }

  toggleMute() {
    if (this._castMode && this._remoteController) {
      this._remoteController.muteOrUnmute();
      return;
    }
    this.video.muted = !this.video.muted;
    if (!this.video.muted && this.video.volume === 0) {
      this.video.volume = 0.5;
      this.volumeSlider.value = 0.5;
    }
    this._updateVolumeUI();
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      (this.container.requestFullscreen?.() || this.container.webkitRequestFullscreen?.())?.catch(() => {});
    } else {
      document.exitFullscreen?.() || document.webkitExitFullscreen?.();
    }
  }

  destroy() {
    this._stopProgressSaving();
    if (this._currentBlobUrl) URL.revokeObjectURL(this._currentBlobUrl);
    clearTracks(this.video);
    this.video.src = '';
    this.video.load();
  }

  getCurrentKey() { return this._currentKey; }
  getCurrentUrl() { return this._currentBlobUrl; }

  // ─── Private ──────────────────────────────────────────────────────────────

  _onPlay() {
    if (this._castMode) return;
    this.playIcon.style.display = 'none';
    this.pauseIcon.style.display = '';
    this._scheduleHide();
  }

  _onPause() {
    if (this._castMode) return;
    this.playIcon.style.display = '';
    this.pauseIcon.style.display = 'none';
    this._showOverlay(true);
  }

  _onVideoEnded() {
    if (this._castMode) return;
    this._stopProgressSaving();
    this.onEnded();
  }

  _onTimeUpdate() {
    if (this._castMode || this._dragging) return;
    const { currentTime, duration } = this.video;
    if (!duration) return;
    const pct = (currentTime / duration) * 100;
    this.progressFill.style.width = `${pct}%`;
    this.progressThumb.style.left = `${pct}%`;
    this.progressBar.setAttribute('aria-valuenow', Math.round(pct));
    this.currentTimeEl.textContent = formatTime(currentTime);
  }

  _onBufferUpdate() {
    if (this._castMode) return;
    const { buffered, duration } = this.video;
    if (!duration || !buffered.length) return;
    const end = buffered.end(buffered.length - 1);
    this.bufferedFill.style.width = `${(end / duration) * 100}%`;
  }

  _onFullscreenChange() {
    const isFs = !!document.fullscreenElement;
    this.fsExpand.style.display = isFs ? 'none' : '';
    this.fsShrink.style.display = isFs ? '' : 'none';
  }

  _startSeek(e) {
    this._dragging = true;
    this._doSeek(e);
  }

  _doSeek(e) {
    const rect = this.progressBar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

    if (this._castMode && this._remotePlayer) {
      const time = ratio * (this._remotePlayer.duration || 0);
      if (isFinite(time)) {
        this.progressFill.style.width = `${ratio * 100}%`;
        this.progressThumb.style.left = `${ratio * 100}%`;
        if (!this._dragging || e.type === 'mouseup') {
          this._remotePlayer.currentTime = time;
          this._remoteController.seek();
        }
      }
      return;
    }

    const time = ratio * this.video.duration;
    if (isFinite(time)) {
      this.progressFill.style.width = `${ratio * 100}%`;
      this.progressThumb.style.left = `${ratio * 100}%`;
      if (!this._dragging || e.type === 'mouseup') {
        this.video.currentTime = time;
      }
    }
  }

  _onProgressHover(e) {
    const rect = this.progressBar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const duration = this._castMode ? (this._remotePlayer?.duration || 0) : (this.video.duration || 0);
    this.progressTooltip.textContent = formatTime(ratio * duration);
    this.progressTooltip.style.left = `${ratio * 100}%`;
  }

  _showOverlay(permanent = false) {
    this.overlay.classList.add('visible');
    if (!permanent) this._scheduleHide();
  }

  _scheduleHide() {
    clearTimeout(this._hideTimer);
    if (this._castMode) return;
    if (this.video.paused) return;
    this._hideTimer = setTimeout(() => {
      this.overlay.classList.remove('visible');
    }, 3000);
  }

  _updateVolumeUI() {
    const muted = this.video.muted || this.video.volume === 0;
    this.volHigh.style.display = muted ? 'none' : '';
    this.volMuted.style.display = muted ? '' : 'none';
    if (!muted) this.volumeSlider.value = this.video.volume;
  }

  _startProgressSaving() {
    this._stopProgressSaving();
    this._progressTimer = setInterval(() => {
      if (this._currentKey && this.video.duration) {
        saveProgress(this._currentKey, this.video.currentTime, this.video.duration);
      }
    }, PROGRESS_SAVE_INTERVAL);
  }

  _stopProgressSaving() {
    if (this._progressTimer) {
      clearInterval(this._progressTimer);
      this._progressTimer = null;
    }
    if (!this._castMode && this._currentKey && this.video.duration > 0) {
      saveProgress(this._currentKey, this.video.currentTime, this.video.duration);
    }
  }

  _flashIndicator(wasPaused) {
    this.playIndicator.textContent = wasPaused ? '⏸' : '▶';
    this.playIndicator.classList.remove('flash');
    void this.playIndicator.offsetWidth;
    this.playIndicator.classList.add('flash');
  }

  _toggleSubtitleMenu() {
    if (this.subtitleMenu.classList.contains('hidden')) {
      this._renderSubtitleMenu();
      this.subtitleMenu.classList.remove('hidden');
    } else {
      this._closeSubtitleMenu();
    }
  }

  _closeSubtitleMenu() {
    this.subtitleMenu.classList.add('hidden');
  }

  _renderSubtitleMenu() {
    const tracks = Array.from(this.video.textTracks);
    this.subtitleTrackList.innerHTML = '';

    const offItem = document.createElement('div');
    offItem.className = 'subtitle-track-item' + (tracks.every(t => t.mode === 'disabled') ? ' active' : '');
    offItem.textContent = 'Off';
    offItem.addEventListener('click', () => {
      disableAllTracks(this.video);
      setSetting('subtitlesEnabled', false);
      this._renderSubtitleMenu();
    });
    this.subtitleTrackList.appendChild(offItem);

    tracks.forEach((track, i) => {
      const item = document.createElement('div');
      item.className = 'subtitle-track-item' + (track.mode === 'showing' ? ' active' : '');
      item.textContent = track.label || `Track ${i + 1}`;
      item.addEventListener('click', () => {
        enableTrack(this.video, i);
        setSetting('subtitlesEnabled', true);
        this._renderSubtitleMenu();
      });
      this.subtitleTrackList.appendChild(item);
    });
  }

  async _loadExternalSub(e) {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const ext = file.name.split('.').pop().toLowerCase();
    const { srtToVtt } = await import('./subtitles.js');
    const vttContent = ext === 'srt' ? srtToVtt(text) : text;
    const blob = new Blob([vttContent], { type: 'text/vtt' });
    const url = URL.createObjectURL(blob);
    addTrack(this.video, url, file.name);
    this._renderSubtitleMenu();
    enableTrack(this.video, Array.from(this.video.textTracks).length - 1);
    e.target.value = '';
  }

  _onKey(e) {
    if (document.getElementById('player-view').classList.contains('hidden')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        this.togglePlay();
        this._showOverlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.seek(-10);
        this._showOverlay();
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.seek(10);
        this._showOverlay();
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (this._castMode && this._remotePlayer) {
          this._remotePlayer.volumeLevel = Math.min(1, this._remotePlayer.volumeLevel + 0.1);
          this._remoteController.setVolumeLevel();
        } else {
          this.video.volume = Math.min(1, this.video.volume + 0.1);
          this.volumeSlider.value = this.video.volume;
          this._updateVolumeUI();
        }
        this._showOverlay();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (this._castMode && this._remotePlayer) {
          this._remotePlayer.volumeLevel = Math.max(0, this._remotePlayer.volumeLevel - 0.1);
          this._remoteController.setVolumeLevel();
        } else {
          this.video.volume = Math.max(0, this.video.volume - 0.1);
          this.volumeSlider.value = this.video.volume;
          this._updateVolumeUI();
        }
        this._showOverlay();
        break;
      case 'KeyF':
        this.toggleFullscreen();
        break;
      case 'KeyM':
        this.toggleMute();
        this._showOverlay();
        break;
      case 'KeyC':
        this._toggleSubtitleMenu();
        break;
      case 'KeyN':
        this.onEnded();
        break;
      case 'KeyP':
        this.onPrev?.();
        break;
      case 'Escape':
        if (!document.fullscreenElement) this.onBack();
        break;
    }
  }
}

function formatTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
