// A thread module for working with ES6 generator functions
// that model threads of execution. This module hopes for
// composeable behaviour.

// fork(g, resume, [context])
//
// Will start the given generator function to run asynchronously.
// When the thread completes, either by an error or by returning
// a value, the given (optional) resume callback is called.
//
// @param g is a generator function with the signature `function*(resume){}`
// @param resume is a NodeJS-style callback function of the form function(err, result) {}
// @param context is an optional object that will be made the context of the
//        generator instance. A new empty object is created if none is passed.
// @return Returns an object with two methods 'throw(err)' and 'cancel()'
//         that can be used to interrupt the "thread". For typical usages,
//         I expect the return value to be ignorable.
//
// Usage example: 
//
//  var thread = require('thread');
//
//  function *myThread(resume) {
//      var x1 = yield step1(arg1, arg2, resume);
//      var x2 = yield step2(argy1, argy2, resume);
//      return doSomething(x1, x2);
//  }
//
//  function *another(resume) {
//      var something = yield thread.fork(myThread, resume);
//      return process(something);
//  }
//
//  thread.fork(another)
//
function fork(g, resume, context) {
    var proc, result, stopped = false, thrownErr = null, finished = false, step = null;
    resume = resume || function () {};
    context = arguments.length < 3 ? {} : context;
    function next() {
        try {
            step = thrownErr ? proc.throw(thrownErr) : proc.next(result);
            if (step.done) {
                finished = true;
                resume(null, step.value);
            }
        } catch (e) {
            finished = true;
            resume(e, null);
        }
    }
    function gresume(stepErr, stepResult) {
        resumedAlready = true;
        result = stepResult;
        thrownErr = stepErr || thrownErr;
        process.nextTick(next);
    }
    process.nextTick(function () { 
        try {
            proc = g.call(context, gresume);
            step = proc.next(); 
            if (step.done) {
                finished = true;
                resume(null, step.value);
            }
        } catch (e) {
            finished = true;
            resume(e, null);
        }
    });
    return {
        isThread: true,
        throw: function (err) {
            thrownErr = err;
            if (!finished && step && step.value && step.value.isThread) {
                step.value.throw(err);
            }
            return this;
        },
        cancel: function () {
            return this.throw(new Error('cancelled'));
        }
    };
}


// par(gs, resume, [sharedContext])
//
// Like `thread`, but starts the generators given in the `gs` array in "parallel".
// The parallel operation will be resumed with an array that collects all the results
// of the various spawned threads.
//
// @param gs is an array of generators that are in the form to be passed to `fork()`
// @param resume is a NodeJS-style callback function that will be called with the
//        results collected from all the forked threads, or with the first error that
//        occurs.
// @param context is an object that can serve for coordinating the various "threads",
//        and is shared among all the parallel processes. If you omit it, each thread
//        will get its own context.
function par(gs, resume, context) {
    var results = new Array(gs.length);
    var resultCount = 0;
    var finished = false; // To ensure that the resume callback only gets called once.
    var thrownErr = null;
    var done = [];
    var doneCount = 0;
    resume = resume || function () {};
    var threads = gs.map(function (g, i) {
        return fork(g, function (err, result) {
            done[i] = true;
            doneCount++; // Either error or normal completion.
            if (finished) { return; }
            if (thrownErr) {
                finished = true;
                return resume(thrownErr, null);
            }
            if (err) {
                finished = true;
                resume(err, i);
            } else {
                resultCount++;
                results[i] = result;
                if (resultCount === gs.length) {
                    // done
                    finished = true;
                    resume(thrownErr, results);
                }
            }
        }, context || {});
    });
    return {
        isThread: true,
        throw: function (err) {
            thrownErr = err;
            var i, N;
            for (i = 0, count = 0, N = threads.length; i < N; ++i) {
                if (!done[i]) {
                    threads[i].throw(err);
                }
            }
            if (!finished) {
                finished = true;
                process.nextTick(function () { resume(err, null); });
            }
            return this;
        },
        cancel: function () {
            return this.throw(new Error('cancelled'));
        },
    };
}

// race(gs, resume, [sharedContext])
//
// Like `par()`, but will finish with the first successful thread
// completion. All other unfinished threads are cancelled.
function race(gs, resume, context) {
    var finished = false;
    var doneCount = 0, N = gs.length;
    var thrownErr = null;
    var finished = true;
    resume = resume || function () {};
    var threads = gs.map(function (g, i) {
        return fork(g, function (stepErr, stepResult) {
            if (finished) { return; }
            if (thrownErr) {
                finished = true;
                resume(thrownErr, null);
                return;
            }
            doneCount++;
            if (stepErr) {
                if (doneCount === N) {
                    finished = true;
                    resume(new Error('Race failed'), null);
                }
            } else {
                // Cancel the other threads being raced. No need to force.
                var j;
                for (j = 0; j < N; ++j) {
                    if (j !== i) {
                        threads[j].cancel();
                    }
                }

                finished = true;
                resume(null, stepResult);
            }
        }, context || {});
    });
    return {
        isThread: true,
        throw: function (err) {
            thrownErr = err;
            if (!finished) {
                finished = true;
                threads.forEach(function (t, i) {
                    t.throw(err);
                });
                process.nextTick(function () { resume(err, null); });
            }
            return this;
        },
        cancel: function () {
            this.throw(new Error('cancelled'));
            return this;
        }
    };
}

// sleep(ms, resume)
//
// Intended to be used within generator functions to create an in-place
// delay like so -
//     
//     yield thread.sleep(1000, resume);
//
function sleep(ms, resume) {
    resume = resume || function () {};
    var theTimeout = setTimeout(function () { 
        if (theTimeout) {
            theTimeout = null;
            resume(null, true); 
        }
    }, ms);
    return {
        isThread: true,
        throw: function (err) {
            if (theTimeout) {
                theTimeout.cancel();
                theTimeout = null;
                process.nextTick(function () { resume(err, null); });
            }
            return this;
        },
        cancel: function () {
            return this.throw(new Error('cancelled'));
        }
    };
}

// timeout(ms)
//
// Makes a generator function that can be "forked" and will
// timeout in the given `ms` milliseconds, with the given
// optional value, or `true` if one is not specified.
//
// You can use the generator returned from `timeout()`
// in a `race` to set a time limit on parallel operations.
//
//     yield thread.race([g1, g2, thread.timeout(3000)], resume);
function timeout(ms, value) {
    return function *(resume) {
        yield sleep(ms, resume);
        return value;
    };
}

exports.fork = fork;
exports.race = race;
exports.par = par;
exports.timeout = timeout;
exports.sleep = sleep;
