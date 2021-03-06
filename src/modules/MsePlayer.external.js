import * as segmentsTypes from '../enums/segments'

import {AUDIO, VIDEO} from '../enums/common'

import EVENTS from '../enums/events'
import MSG from '../enums/messages'
import * as mseUtils from '../utils/mseUtils'
import {logger, enableLogs} from '../utils/logger'

import 'core-js/fn/array/find'

const TYPE_CONTENT_VIDEO = VIDEO
const TYPE_CONTENT_AUDIO = AUDIO

const BUFFER_MODE_SEQUENCE = 'sequence' // segments

const LIVE = 'live'
const WS_COMMAND_SEEK_LIVE = ''
const WS_COMMAND_SEEK = 'play_from='
const DEFAULT_ERRORS_BEFORE_STOP = 1
const DEFAULT_UPDATE = 100

let errorsCount = 0

export default class MSEPlayer {

  static replaceHttpByWS(url) {
    return mseUtils.replaceHttpByWS(url)
  }

  static isSupported() {
    return mseUtils.isSupportedMSE()
  }
  /**
   *
   * @param media HTMLMediaElement
   * @param urlStream
   * @param opts
   */
  constructor(media, urlStream, opts) {

    if (opts.debug) {
      enableLogs(true)
      window.humanTime = mseUtils.humanTime
    }

    if (!(media instanceof HTMLMediaElement)) {
      throw new Error(MSG.NOT_HTML_MEDIA_ELEMENT)
    }

    this.media = media

    this.url = urlStream
    this.opts = opts || {}
    this.opts.progressUpdateTime = this.opts.progressUpdateTime || DEFAULT_UPDATE

    this.opts.errorsBeforeStop = this.opts.errorsBeforeStop
      ? this.opts.errorsBeforeStop
      : DEFAULT_ERRORS_BEFORE_STOP

    if (typeof this.opts.errorsBeforeStop !== 'number'
        || isNaN(this.opts.errorsBeforeStop)) {
      throw new Error('invalid errorsBeforeStop param, should be number')
    }

    this.onProgress = opts && opts.onProgress
    this.onMediaInfo = opts && opts.onMediaInfo
    this.onError = opts && opts.onError

    this.doArrayBuffer = mseUtils.doArrayBuffer.bind(this)
    this.maybeAppend = this.maybeAppend.bind(this)

    this.init()

    this.onAttachMedia({media})
    this.onSBUpdateEnd = this.onSBUpdateEnd.bind(this)
  }

  play(time, videoTrack, audioTack) {
    if (this.opts.debug) {
      logger.log('FlussonicMsePlayer: play()')
    }
    return this._play(time, videoTrack, audioTack)
  }

  stop() {
    return this.onMediaDetaching()
  }

  seek(utc) {
    try {
      if (!utc) {
        throw new Error('utc should be "live" or UTC value')
      }
      const commandStr = utc === LIVE
        ? WS_COMMAND_SEEK_LIVE
        : WS_COMMAND_SEEK
      logger.log(`${commandStr}${utc}`)
      this.websocket.send(`${commandStr}${utc}`)

      // need for determine old frames
      this.seekValue = utc

      for(let k in this.sourceBuffer) {
        this.sourceBuffer[k].abort()
        this.sourceBuffer[k].mode = BUFFER_MODE_SEQUENCE
      }

      this.segments = []

    } catch (err) {
      logger.warn(`onMediaDetaching:${err.message} while calling endOfStream`)
    }
  }

  pause() {
    if (
      this._pause ||
      !this.media ||
      !this.websocket ||
      !this.mediaSource ||
      (this.mediaSource && this.mediaSource.readyState !== 'open') ||
      !this.playPromise
    ) {
      return
    }

    // https://developers.google.com/web/updates/2017/06/play-request-was-interrupted
    this.playPromise.then(pause.bind(this))
    function pause() {
      this.media.pause()
      this.websocket.send('pause')
      this._pause = true
      this.playing = false

      if (this.onPause) {
        try {
          this.onPause()
        } catch (e) {
          logger.error('Error ' + e.name + ':' + e.message + '\n' + e.stack)
        }
      }
    }
  }

  setTracks(tracks) {
    if (!this.mediaInfo) {
      logger.warn('Media info did not loaded. Should try after onMediaInfo triggered or inside.')
      return
    }

    if (!Array.isArray(tracks)) {
      logger.error('tracks should be an Array instance: ["v1", "a1"]')
    }

    const videoTracksStr = tracks
      .filter(id => {
        const stream = this.mediaInfo.streams.find(s => id === s['track_id'])
        return !!stream && stream.content === TYPE_CONTENT_VIDEO
      })
      .join('')

    const audioTracksStr = tracks
      .filter(id => {
        const stream = this.mediaInfo.streams.find(s => id === s['track_id'])
        return !!stream && stream.content === TYPE_CONTENT_AUDIO
      })
      .join('')

    return this._setTracks(videoTracksStr, audioTracksStr)
  }

  /**
   *
   *  Private members
   *
   */

  _play(time, videoTrack, audioTack) {
    return new Promise((resolve, reject) => {
      if (this.playing) {
        logger.log('_play: terminate because already has been playing')
        return resolve()
      }

      if (this._pause && !this.afterSeekFlag) {
        this._resume()
        logger.log('_play: terminate because _paused and should resume')
        return resolve()
      }

      // TODO: to observe this case, I have no idea when it fired
      if (!this.mediaSource) {
        this.onAttachMedia({media: this.media})
        this.onsoa = this._play.bind(this, time, videoTrack, audioTack)
        this.mediaSource.addEventListener(EVENTS.MEDIA_SOURCE_SOURCE_OPEN, this.onsoa)
        logger.warn('mediaSource did not create')
        this.resolveThenMediaSourceOpen = this.resolveThenMediaSourceOpen
          ? this.resolveThenMediaSourceOpen
          : resolve
        this.rejectThenMediaSourceOpen = this.rejectThenMediaSourceOpen
            ? this.rejectThenMediaSourceOpen
            : reject
        return
      }

      this.playTime = time
      this.videoTrack = videoTrack
      this.audioTack = audioTack

      // deferring execution
      if (this.mediaSource && this.mediaSource.readyState !== 'open') {
        logger.warn('readyState is not "open"')
        this.shouldPlay = true
        this.resolveThenMediaSourceOpen = this.resolveThenMediaSourceOpen
          ? this.resolveThenMediaSourceOpen
          : resolve
        this.rejectThenMediaSourceOpen = this.rejectThenMediaSourceOpen
          ? this.rejectThenMediaSourceOpen
          : reject
        return
      }

      this._pause = false
      this.playing = true

      const startWS = mseUtils.startWebSocket(this.url, time, videoTrack, audioTack)

      startWS.bind(this)()

      // https://developers.google.com/web/updates/2017/06/play-request-was-interrupted
      this.playPromise = this.media.play()
      this.startProgressTimer()
      this.playing = true

      this.playPromise.then(() => {
        if (this.resolveThenMediaSourceOpen) {
          this.resolveThenMediaSourceOpen()
          this.resolveThenMediaSourceOpen = void 0
          this.rejectThenMediaSourceOpen = void 0
        }
      }, () => {
        if (this.rejectThenMediaSourceOpen) {
          this.rejectThenMediaSourceOpen()
          this.resolveThenMediaSourceOpen = void 0
          this.rejectThenMediaSourceOpen = void 0
        }
      })
      return this.playPromise
    })
  }

  init() {
    // start new implementation
    this.segments = []
    this.sourceBuffer = {}
    this.flushRange = [];
    this.appended = 0;
    this._missed = 0;
    // end new inplementation

    this._buffers = {}
    this._queues = {}
    this.playing = false

    // flag to pending execution(true)
    this.shouldPlay = false

    // store to execute pended method play
    this.playTime = void 0
    this.audioTack = ''
    this.videoTrack = ''
    this.endProgressTimer()
  }

  _resume() {
    this.websocket.send('resume')
    this.playPromise = this.media.play()
    this._pause = false
    this.playing = true
  }

  onMediaDetaching() {
    if (this.stopRunning) {
      logger.warn('stop is running.')
      return
    }
    this.stopRunning = true
    // https://developers.google.com/web/updates/2017/06/play-request-was-interrupted
    const bindedMD = this.handlerMediaDetaching.bind(this)
    if (this.playPromise) {
      // there are two cases:
      // resolved/rejected
      // both required to shutdown ws, mediasources and etc.
      return this.playPromise.then(bindedMD, bindedMD)
    }
    if (!this.playPromise) {
      return this.handlerMediaDetaching()
    }
  }

  handlerMediaDetaching() {
    logger.info('media source detaching')

    let mediaEmptyPromise

    // destroy media source and detach from media element
    this.removeMediaSource()

    if (this.media) {
      this.media.removeEventListener(EVENTS.MEDIA_ELEMENT_PROGRESS, this.oncvp) // checkVideoProgress
      mediaEmptyPromise = new Promise(resolve => {
        this._onmee = this.onMediaElementEmptied(resolve).bind(this)
      })
      mediaEmptyPromise.then(() => this.stopRunning = false)
      this.media.addEventListener(EVENTS.MEDIA_ELEMENT_EMPTIED, this._onmee)
    }

    this.oncvp = null

    this.mediaSource = null

    this.init()
    this.destroyWebsocket()

    return mediaEmptyPromise
  }

  removeMediaSource() {
    const ms = this.mediaSource
    if (ms) {
      if (ms.readyState === 'open') {
        try {
          // endOfStream could trigger exception if any sourcebuffer is in updating state
          // we don't really care about checking sourcebuffer state here,
          // as we are anyway detaching the MediaSource
          // let's just avoid this exception to propagate
          ms.endOfStream()
        } catch (err) {
          logger.warn(`onMediaDetaching:${err.message} while calling endOfStream`)
        }
      }

      ms.removeEventListener(EVENTS.MEDIA_SOURCE_SOURCE_OPEN, this.onmso)
      ms.removeEventListener(EVENTS.MEDIA_SOURCE_SOURCE_ENDED, this.onmse)
      ms.removeEventListener(EVENTS.MEDIA_SOURCE_SOURCE_CLOSE, this.onmsc)
      this.onmso = null
      this.onmse = null
      this.onmsc = null
    }

    // Detach properly the MediaSource from the HTMLMediaElement as
    // suggested in https://github.com/w3c/media-source/issues/53.
    URL.revokeObjectURL(this.media.src)
    this.media.removeAttribute('src')
    this.media.load()
  }

  onMediaElementEmptied(resolve) {
    if (this._onmee && this.media) {
      this.media.removeEventListener(EVENTS.MEDIA_ELEMENT_EMPTIED, this._onmee)
      this._onmee = void 0
    }
    return resolve()
  }

  onAttachMedia(data) {
    this.media = data.media
    const media = this.media
    if (media) {
      // setup the media source
      const ms = (this.mediaSource = new MediaSource())
      //Media Source listeners

      this.onmse = this.onMediaSourceEnded.bind(this)
      this.onmsc = this.onMediaSourceClose.bind(this)

      ms.addEventListener(EVENTS.MEDIA_SOURCE_SOURCE_ENDED, this.onmse)
      ms.addEventListener(EVENTS.MEDIA_SOURCE_SOURCE_CLOSE, this.onmsc)
      // link video and media Source
      media.src = URL.createObjectURL(ms)

      this.oncvp = mseUtils.checkVideoProgress(media).bind(this)
      this.media.addEventListener(EVENTS.MEDIA_ELEMENT_PROGRESS, this.oncvp)
      return new Promise(resolve => {
        this.onmso = this.onMediaSourceOpen.bind(this, resolve)
        ms.addEventListener(EVENTS.MEDIA_SOURCE_SOURCE_OPEN, this.onmso)
      })
    }
  }

  onMediaSourceOpen(resolve) {
    resolve()
    let mediaSource = this.mediaSource
    if (mediaSource) {
      // once received, don't listen anymore to sourceopen event
      mediaSource.removeEventListener(EVENTS.MEDIA_SOURCE_SOURCE_OPEN, this.onmso)
    }

    // play was called but stoped and was pend(1.readyState is not open)
    // and time is come to execute it
    if (this.shouldPlay) {
      logger.info(
        `readyState now is ${this.mediaSource.readyState}, and will be played`,
        this.playTime,
        this.audioTack,
        this.videoTrack
      )
      this.shouldPlay = false
      this._play(this.playTime, this.audioTack, this.videoTrack)
    }
  }

  destroyWebsocket() {
    if (this.websocket) {
      this.websocket.removeEventListener(EVENTS.WS_MESSAGE, this.onwsdm)
      this.websocket.onclose = function() {} // disable onclose handler first
      this.websocket.close()
      this.onwsdm = null
    }
  }

  onWebsocketOpen() {
    this.websocket.send('resume')
    this.websocket.removeEventListener(EVENTS.WS_OPEN, this.onwso)
  }

  dispatchMessage(e) {
    if (this.stopRunning || this._pause || !this.playing) {
      return
    }

    const rawData = e.data
    const isDataAB = rawData instanceof ArrayBuffer

    try {
      // after seek can receive old frames, it should be filtered
      if (this.isOldFrameAfterSeek(rawData)) {return}


      // wait for MSE_INIT_SEGMENT
      if (this.waitForInitFrame && isDataAB) {
        return logger.log('old frames')
      }

      // MSE_INIT_SEGMENT
      if (!isDataAB) {
        this.procInitSegment(rawData)
        return
      }

      // ArrayBuffer data
      if (isDataAB) {
        const segment = this.rawDataToSegmnet(rawData)
        this.segments.push(segment)
        this.doArrayBuffer()
      }

    } catch (err) {
      logger.error(mseUtils.errorMsg(e), err)

      if (this.media && this.media.error) {
        logger.error('MediaError:', this.media.error)
      }

      if (isDataAB) {
        logger.error('Data:', mseUtils.debugData(e.data))
      }
      errorsCount++
      if (errorsCount >= this.opts.errorsBeforeStop) {
        errorsCount = 0
        this.stopPromise = this.stop()
      }

      if (this.onError) {
        this.onError(err, e)
      }
    }
  }

  isOldFrameAfterSeek(rawData) {
    if (this.seekValue) {
      let cUtc = 0
      let isDataAB = rawData instanceof ArrayBuffer
      if (isDataAB) {
        cUtc = mseUtils.getRealUtcFromData(mseUtils.RawDataToUint8Array(rawData))
      } else {
        logger.log('not Array buffer')
      }

      if (Math.abs(cUtc - this.seekValue) > 20) {
        logger.warn('skip old frame',
          mseUtils.humanTime(cUtc), mseUtils.humanTime(this.seekValue),
          cUtc, this.seekValue, cUtc - this.seekValue)
        return true
      } else {
        this.seekNormCount = this.seekNormCount
          ? this.seekNormCount + 1
          : 1
      }

      if (this.seekNormCount > 10) {
        this.seekValue = void 0
        this.seekNormCount = 0
      }
    }
    return false
  }

  rawDataToSegmnet(rawData) {
    const view = mseUtils.RawDataToUint8Array(rawData)
    const trackId = mseUtils.getTrackId(view)
    const trackType = this.getTypeBytrackId(trackId)
    return {type: trackType, data: view}
  }

  getTypeBytrackId(id) {
    return this.audioTrackId === id
      ? AUDIO
      : VIDEO
  }

  procInitSegment(rawData) {
    const data = JSON.parse(rawData)
    if (data.type !== segmentsTypes.MSE_INIT_SEGMENT) {
      return logger.warn('type is not MSE_INIT_SEGMENT')
    }

    if (this.waitForInitFrame) {
      this.waitForInitFrame = false
    }

    if (this.isBuffered()) {
      this.media.pause()
      this.previouslyPaused = false
      this._setTracksFlag = true
      this.immediateSwitch = true
      const startOffset = 0
      const endOffset = Infinity
      // TODO: should invoke remove method of SourceBuffer's
      this.flushRange.push({ start: startOffset, end: endOffset, type: void 0 });
      // attempt flush immediately
      this.flushBufferCounter = 0;
      this.doFlush()
    }

    // calc this.audioTrackId this.videoTrackId
    this.setTracksByType(data)



    const metadata = data.metadata
    const streams = data.metadata.streams

    const activeStreams = {
      video: streams[this.videoTrackId - 1]['track_id'],
      audio: streams[this.audioTrackId - 1]['track_id'],
    }

    this.doMediaInfo({...metadata, activeStreams})
    logger.log(data)

    if (this.mediaSource && !this.mediaSource.sourceBuffers.length) {
      this.createSourceBuffers(data)
    }

    // TODO: describe cases
    data.tracks.forEach(track => {
      const view = mseUtils.base64ToArrayBuffer(track.payload)
      const segment = {
        type: this.getTypeBytrackId(track.id),
        isInit: true,
        data: view,
      }
      this.maybeAppend(segment)
    })

  }

  isBuffered() {
    let appended = 0
    let sourceBuffer = this.sourceBuffer;
    for (let type in sourceBuffer) {
      appended += sourceBuffer[type].buffered.length;
    }
    return appended > 0
  }

  doFlush () {
    // loop through all buffer ranges to flush
    while (this.flushRange.length) {
      let range = this.flushRange[0];
      // flushBuffer will abort any buffer append in progress and flush Audio/Video Buffer
      if (this.flushBuffer(range.start, range.end, range.type)) {
        // range flushed, remove from flush array
        this.flushRange.shift();
        this.flushBufferCounter = 0;
      } else {
        this._needsFlush = true;
        // avoid looping, wait for SB update end to retrigger a flush
        return;
      }
    }
    if (this.flushRange.length === 0) {
      // everything flushed
      this._needsFlush = false;

      // let's recompute this.appended, which is used to avoid flush looping
      let appended = 0;
      let sourceBuffer = this.sourceBuffer;
      try {
        for (let type in sourceBuffer) {
          appended += sourceBuffer[type].buffered.length;
        }
      } catch (error) {
        // error could be thrown while accessing buffered, in case sourcebuffer has already been removed from MediaSource
        // this is harmess at this stage, catch this to avoid reporting an internal exception
        logger.error('error while accessing sourceBuffer.buffered');
      }
      this.appended = appended;
      this._setTracksFlag = false
    }
  }

  /*
    flush specified buffered range,
    return true once range has been flushed.
    as sourceBuffer.remove() is asynchronous, flushBuffer will be retriggered on sourceBuffer update end
  */
  flushBuffer (startOffset, endOffset, typeIn) {
    let sb, i, bufStart, bufEnd, flushStart, flushEnd, sourceBuffer = this.sourceBuffer;
    if (Object.keys(sourceBuffer).length) {
      logger.log(`flushBuffer,pos/start/end: ${this.media.currentTime.toFixed(3)}/${startOffset}/${endOffset}`);
      // safeguard to avoid infinite looping : don't try to flush more than the nb of appended segments
      if (this.flushBufferCounter < this.appended) {
        for (let type in sourceBuffer) {
          // check if sourcebuffer type is defined (typeIn): if yes, let's only flush this one
          // if no, let's flush all sourcebuffers
          if (typeIn && type !== typeIn) {
            continue;
          }

          sb = sourceBuffer[type];
          // we are going to flush buffer, mark source buffer as 'not ended'
          sb.ended = false;
          if (!sb.updating) {
            try {
              for (i = 0; i < sb.buffered.length; i++) {
                bufStart = sb.buffered.start(i);
                bufEnd = sb.buffered.end(i);
                // workaround firefox not able to properly flush multiple buffered range.
                if (navigator.userAgent.toLowerCase().indexOf('firefox') !== -1 && endOffset === Number.POSITIVE_INFINITY) {
                  flushStart = startOffset;
                  flushEnd = endOffset;
                } else {
                  flushStart = Math.max(bufStart, startOffset);
                  flushEnd = Math.min(bufEnd, endOffset);
                }
                /* sometimes sourcebuffer.remove() does not flush
                   the exact expected time range.
                   to avoid rounding issues/infinite loop,
                   only flush buffer range of length greater than 500ms.
                */
                if (Math.min(flushEnd, bufEnd) - flushStart > 0.5) {
                  this.flushBufferCounter++;
                  logger.log(`flush ${type} [${flushStart},${flushEnd}], of [${bufStart},${bufEnd}], pos:${this.media.currentTime}`);
                  sb.remove(flushStart, flushEnd);
                  return false;
                }
              }
            } catch (e) {
              logger.warn('exception while accessing sourcebuffer, it might have been removed from MediaSource');
            }
          } else {
            // logger.log('abort ' + type + ' append in progress');
            // this will abort any appending in progress
            // sb.abort();
            logger.warn('cannot flush, sb updating in progress');
            return false;
          }
        }
      } else {
        logger.warn('abort flushing too many retries');
      }
      logger.log('buffer flushed');
    }
    // everything flushed !
    return true;
  }

  doMediaInfo(metadata) {
    logger.log(metadata)
    if (this.onMediaInfo) {
      this.mediaInfo = metadata
      try {
        this.onMediaInfo(metadata)
      } catch (e) {
        logger.error(mseUtils.errorMsg(e))
      }
    }
  }

  getVideoTracks() {
    if (!this.mediaInfo) {
      return
    }
    return this.mediaInfo.streams.filter(s => s.content === TYPE_CONTENT_VIDEO)
  }

  getAudioTracks() {
    if (!this.mediaInfo) {
      return
    }
    return this.mediaInfo.streams.filter(s => s.content === TYPE_CONTENT_AUDIO)
  }

  maybeAppend(segment) {

    if (this._needsFlush) {
      this.segments.unshift(segment)
      return
    }

    const buffer = this.sourceBuffer[segment.type]

    if (buffer.updating) {
      this.segments.unshift(segment)
    } else {
      buffer.appendBuffer(segment.data)
      this.appended++
      // TODO: find where switch off
      this.appending = true
    }
  }

  startProgressTimer() {
    this.timer = setInterval(this.onTimer.bind(this), this.opts.progressUpdateTime)
  }

  /**
   * on immediate level switch end, after new fragment has been buffered:
   * - nudge video decoder by slightly adjusting video currentTime (if currentTime buffered)
   * - resume the playback if needed
   */
  immediateLevelSwitchEnd () {
    const media = this.media
    if (media && media.buffered.length) {
      this.immediateSwitch = false
      // if (BufferHelper.isBuffered(media, media.currentTime)) {
        // only nudge if currentTime is buffered
        // media.currentTime -= 0.0001;
      // }
      if (!this.previouslyPaused) {
        media.play()
      }
    }
  }

  endProgressTimer() {
    clearInterval(this.timer)
    this.timer = void 0
  }

  onTimer() {
    // #TODO explain
    if (this.immediateSwitch) {
      this.immediateLevelSwitchEnd()
    }

    if (!(this.utc && this.utc != this.utcPrev)) {
      return
    }

    this.utcPrev = this.utc

    if (!this.onProgress) {return}
    try {
      this.onProgress(this.utc)
    } catch (e) {
      logger.error(mseUtils.errorMsg(e))
    }
  }

  onMediaSourceEnded() {
    logger.log('media source ended')
  }

  onMediaSourceClose() {
    logger.log('media source closed')
  }

  setTracksByType(data) {
    data.tracks.forEach((s) => {
      const isVideo = s.content === VIDEO;
      const id = s.id

      if (!isVideo) {
        this.audioTrackId = id
      } else {
        this.videoTrackId = id
      }

    })
  }

  createSourceBuffers(data) {
    const sourceBuffer = this.sourceBuffer;

    data.tracks.forEach((s) => {
      const isVideo = s.content === VIDEO;
      const mimeType = isVideo
        ? 'video/mp4; codecs="avc1.4d401f"'
        : 'audio/mp4; codecs="mp4a.40.2"'

      const id = s.id

      sourceBuffer[s.content] = this.mediaSource.addSourceBuffer(mimeType)
      const buffer = sourceBuffer[s.content]

      buffer.addEventListener(EVENTS.BUFFER_UPDATE_END, this.onSBUpdateEnd)
    })

  }

  onSBUpdateEnd() {
    if (this._needsFlush) {
      this.doFlush()
    }
    if (!this._needsFlush && this.segments.length) {
      this.doArrayBuffer()
    }
  }

  _setTracks(videoTrack, audioTrack) {
    this.websocket.send(`set_tracks=${videoTrack}${audioTrack}`)
    this._setTracksFlag = true
    this.waitForInitFrame = true
  }
}
