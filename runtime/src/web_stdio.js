// Browser build: stdout / stderr written by the emulation threads must not
// wait for the page's main thread. Emscripten proxies every fd_write to the
// main thread synchronously (the filesystem lives there), so one log line
// stalls the game while the page is busy (drawing, garbage collection). Text
// for fds 1 and 2 is printed from the calling thread instead (worker console
// output is forwarded asynchronously); other fds keep the synchronous
// filesystem path.
addToLibrary({
  $psxFdWriteFs__proxy: 'sync',
  $psxFdWriteFs__deps: ['$SYSCALLS', '$doWritev', '$FS'],
  $psxFdWriteFs: (fd, iov, iovcnt, pnum) => {
    try {
      var stream = SYSCALLS.getStreamFromFD(fd);
      var num = doWritev(stream, iov, iovcnt);
      HEAPU32[pnum >> 2] = num;
      return 0;
    } catch (e) {
      if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
      return e.errno;
    }
  },
  $psxPrintBuf: ['', '', ''],
  fd_write__proxy: 'none',
  fd_write__deps: ['$psxFdWriteFs', '$psxPrintBuf', '$UTF8ArrayToString'],
  fd_write: (fd, iov, iovcnt, pnum) => {
    if (fd !== 1 && fd !== 2) return psxFdWriteFs(fd, iov, iovcnt, pnum);
    var num = 0, text = '';
    for (var i = 0; i < iovcnt; i++) {
      var ptr = HEAPU32[(iov + i * 8) >> 2];
      var len = HEAPU32[(iov + i * 8 + 4) >> 2];
      if (len) text += UTF8ArrayToString(HEAPU8.slice(ptr, ptr + len));
      num += len;
    }
    var all = psxPrintBuf[fd] + text;
    var nl = all.lastIndexOf('\n');
    if (nl >= 0) {
      for (var line of all.slice(0, nl).split('\n')) (fd === 1 ? out : err)(line);
      all = all.slice(nl + 1);
    }
    psxPrintBuf[fd] = all;
    HEAPU32[pnum >> 2] = num;
    return 0;
  },
});
