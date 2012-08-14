var cluster = require('cluster');
var exec = require('child_process').exec;
var fs = require('fs');

var config = {
    numWorkers: require('os').cpus().length,
    refreshTime: 1000, // Milliseconds between data refreshes.
    logFileName: "log"+new Date().toISOString().slice(0,19).replace(/:/g,"-")+".csv",
    worker: {
        port: 8888,
        setNoDelay: true,
        pingInterval: 20000,  // Pings to each client.
        samplingInterval: 10, // Event loop responsiveness sampling.
        gcInterval: 60*1000,
    },
};

cluster.setupMaster({
    exec: "worker.js"
});

// Fork workers as needed.
for (var i = 0; i < config.numWorkers; i++)
    (function(worker) {
        worker.callbacks = {};
        worker.maxMessageId = 1;
        worker.requestData = function(callback) {
            var id = worker.maxMessageId++;
            worker.callbacks[id] = callback;
            worker.send({id: id});
        };
        worker.on('message', function(data) {
            if (!data.id) return;
            var callback = worker.callbacks[data.id];
            if (!callback) return;
            delete worker.callbacks[data.id];
            callback(data);
        });
        worker.on('exit', function(code, signal) {
            console.log('Worker died: ', worker.process.pid, code, signal);
        });
    })(cluster.fork({WORKER_CONFIG: JSON.stringify(config.worker)}));


// ==== Main system metrics loop ===============================================
function hrtime() { var hr = process.hrtime(); return hr[0]*1e3 + hr[1]*1e-6; }

var startTime = hrtime();
function iterate(step) {
    requestAsyncDataFrame(step, function(dataFrame){
        printFrameToScreen(dataFrame);
        logFrame(dataFrame);
    });
    setTimeout(iterate, startTime + (step+1)*config.refreshTime - hrtime(), step+1);
}
setTimeout(iterate, config.refreshTime, 1);


// ==== Asynchronously gather system metrics into a single dataFrame ================
var lastCpuStats = undefined;
var cpuStatNames = ['user', 'nice', 'sys', 'idle', 'iowait', 'irq', 'softirq', 'steal', 'guest'];
function getCPUStats(callback) {
    fs.readFile("/proc/stat", "utf8", function(err, stats) {
        if (err) return callback(err, {});
        stats = stats.split("\n")[0].split(" ").filter(Boolean).slice(1).map(Number);
        var diffStats = [0,0,0,0,0,0,0,0,0,0];
        if (lastCpuStats)
            diffStats = stats.map(function(s, i) {return s - lastCpuStats[i];});
        lastCpuStats = stats;

        var sum = 100;//diffStats.reduce(function(a,b) {return a+b;}, 0) || 1;
        
        var res = {};
        for (var i = 0; i < cpuStatNames.length; i++)
            res[cpuStatNames[i]] = diffStats[i] * 100 / sum;
        callback(null, res);
    })
}

// See description of /proc/meminfo: f.ex. http://lwn.net/Articles/28345/
var memStatNames = {
    total: 'MemTotal', 
    free: 'MemFree',
    used: function(m) {return m.MemTotal-m.MemFree-(m.Buffers+m.Cached+m.SwapCached);},
    caches: function(m) {return m.Buffers+m.Cached+m.SwapCached;},
    shmem: 'Shmem',
    mapped: 'Mapped',
    slab: 'Slab',
    vmalloc: 'VmallocUsed',
    swapTotal: 'SwapTotal',
    swapUsed: function(m) {return m.SwapTotal-m.SwapFree;},
};
function getMemStats(callback) {
    fs.readFile("/proc/meminfo", "utf8", function(err, stats) {
        if (err) return callback(err, {});
        
        var m = {};
        stats.split("\n").filter(Boolean).forEach(function(s) {
            var vals = s.split(" ").filter(Boolean);
            m[vals[0].slice(0, -1)] = +vals[1]*1024; // KB -> bytes
        });

        var res = {};
        for (var key in memStatNames) {
            var val = memStatNames[key];
            res[key] = (typeof val === 'function') ? val(m) : m[val];
        }

        callback(null, res);
    });
}

var pagesize = 4096; // Operating system memory page size.
exec('getconf PAGESIZE', function(err, stdout) {
    if (err) return;
    pagesize = +stdout;
});

var pidStats = {};
function getProcessStats(pid, callback) {
    fs.readFile("/proc/"+pid+"/stat", "utf8", function(err, stats) {
        if (err) return callback(err, {});
        stats = stats.split(" ").map(Number);
        
        var procTime = stats[13] + stats[14]; // User+sys time of the process in jiffles (10 ms).
        var wallTime = hrtime();
        var cpuPerc = 0;
        if (pidStats[pid]) {
            var last = pidStats[pid];
            cpuPerc = (procTime-last.procTime)*1000/(wallTime-last.wallTime);
        }
        pidStats[pid] = {procTime: procTime, wallTime: wallTime};

        callback(null, {
            pid: pid,
            cpuPercent: cpuPerc,          // Percent CPU taken
            cpuTime: procTime / 100,      // CPU time taken (sec)
            vmem: stats[22],              // Virtual memory (bytes)
            rss: stats[23] * pagesize,    // Resident mem (bytes)
            threads: stats[19],           // Threads count
        });
    });
}

function appendStats(data, dest) {
    for (var key in data) {
        var val = data[key];
        if (typeof val == 'object') {
            if (!dest[key]) dest[key] = {};
            appendStats(val, dest[key]);
        } else if (typeof val == 'number') {
            if (!dest[key]) dest[key] = [];
            dest[key].push(val);
        } else throw new Error('Unknown type to append.');
    }
}

function processDataFrame(d) { // Count cumulative metrics.
    d.generationTime = hrtime() - d.time;

    // Convert worker ticks to statictics.
    var totals = {};
    d.workerIds.forEach(function(id) {
        var data = d.workersData[id];
        var ticks = data.ticks.length ? data.ticks : [0];
        ticks.sort(function(a,b) {return a-b});
        data.mint = ticks[0];
        data.avgt = data.timeFromLast/ticks.length;
        data.p50t = ticks[Math.floor(ticks.length*0.50)]; // median
        data.p90t = ticks[Math.floor(ticks.length*0.90)]; // 90 percentile
        data.maxt = ticks[ticks.length-1];
        appendStats(data, totals);
        appendStats(d.workersProc[id], totals);
    });

    // Calculate cumulative metrics.
    var sum = function(arr) {return arr.reduce(function(a,b){return a+b},0)};
    var avg = function(arr) {return sum(arr)/arr.length};
    var max = function(arr) {return arr.reduce(function(a,b){return Math.max(a,b)},0)};

    d.totals = {
        cpuPercent: sum(totals.cpuPercent),
        rss: sum(totals.rss),
        mem: {
            heapTotal: sum(totals.mem.heapTotal),
            heapUsed: sum(totals.mem.heapUsed),
        },
        conns: sum(totals.conns),
        packets: sum(totals.packets),
        avgt: avg(totals.avgt),
        p90t: avg(totals.p90t),
        maxt: max(totals.maxt),
    };
}

function requestAsyncDataFrame(step, callback) {
    var callbacksToDo = 0;
    var dataFrame = {
        step: step,
        time: hrtime(),
        startTime: startTime,
        workerIds: Object.keys(cluster.workers),
        workersData: {},
        workersProc: {},
    };

    var checkFinished = function() {
        if (--callbacksToDo === 0) {
            processDataFrame(dataFrame);
            callback(dataFrame);
        }
    };

    // Request general PC info
    callbacksToDo++;
    getCPUStats(function(err, stats) {
        dataFrame.cpu = stats;
        checkFinished();
    });

    callbacksToDo++;
    getMemStats(function(err, stats) {
        dataFrame.mem = stats;
        checkFinished();
    });

    callbacksToDo++;
    getProcessStats(process.pid, function(err, stats) { // Master process info
        dataFrame.masterProc = stats;
        checkFinished();
    });

    // Request info from workers
    dataFrame.workerIds.forEach(function(id) {
        var worker = cluster.workers[id];
        callbacksToDo++;
        worker.requestData(function(data) {
            dataFrame.workersData[id] = data;
            checkFinished();
        });
        callbacksToDo++;
        getProcessStats(worker.process.pid, function(err, stats) {
            dataFrame.workersProc[id] = stats;
            checkFinished();
        });
    });
}


// ==== Print on the screen current stats frame ================================
function clearScreen() { process.stdout.write("\033c"); /* <ESC>c - reset terminal (no history) */ }
function pad(str, width) { while(str.length < width) str=" "+str; return str; }
function p(n, padding, digits, factor) { return pad((n/(1 << (10*(factor||0)))).toFixed(digits||0), padding||0); }

function processStatsStr(d) {
    return (d.pid ? "["+p(d.pid,5)+"]: " :"") + 
        p(d.cpuPercent, 4, 1) + "% cpu," +
        p(d.rss,4,0,2) + "Mb";
}

function workerDataStr(d) {
    return p(d.conns, 6) + " conns, " + 
        p(d.mem.heapUsed,0,1,2) + "/" + p(d.mem.heapTotal,0,1,2) + "Mb heap, " +
        p(d.avgt,2) + "/" + p(d.p90t,2) + "/" + p(d.maxt,2) + "ms ticks";
}

function printFrameToScreen(d) {
    clearScreen();
    var elapsed = new Date(hrtime()-startTime+100).toUTCString().slice(17, 25);
    console.log("Elapsed: " + elapsed + "; " + new Date());
    console.log("Cpu: "+p(d.cpu.user,4,1)+"% user, "+p(d.cpu.sys,4,1)+"% sys, "+p(d.cpu.idle,4,1)+"% idle (percent of single core)");
    console.log("Mem: "+p(d.mem.used,0,1,2)+" Mb used, "+p(d.mem.free,0,1,2)+" Mb free, "+p(d.mem.caches,0,1,2)+" Mb buf+cache");
    console.log();
    console.log("Master"+processStatsStr(d.masterProc));
    d.workerIds.forEach(function(id) {
        console.log("Worker"+processStatsStr(d.workersProc[id])+","+workerDataStr(d.workersData[id]));
    });
    console.log();
    console.log("Total:         "+ processStatsStr(d.totals)+","+workerDataStr(d.totals));
    //console.log("Frame generation time: "+p(d.generationTime,0,1,0)+" ms.");
    console.log();
    var kb = p(fs.statSync(config.logFileName).size, 0, 0, 1);
    console.log("Logging to '"+config.logFileName+"' ("+kb+" Kb). Press Ctrl-C to exit.");
}

// ==== Log everything to the log file =========================================

var logStream = fs.createWriteStream(config.logFileName);
process.on('exit', function() { logStream.end(); }); // Flush file on exit.

// We use CSV RFC4180 variant: CRLF separated strings, Comma-separated values. 
function logFrame(d) {
    var values = [
        // Main block
        d.step,
        d.totals.conns,
        // CPU block
        d.cpu.user.toFixed(1),
        d.cpu.sys.toFixed(1),
        d.cpu.idle.toFixed(1),
        d.totals.cpuPercent.toFixed(1),
        // Memory block
        p(d.mem.used,0,1,2),
        p(d.mem.caches,0,1,2),
        p(d.totals.rss,0,1,2),
        p(d.totals.mem.heapUsed,0,1,2),
        p(d.totals.mem.heapTotal,0,1,2),
        // Ticks block
        d.totals.avgt.toFixed(1),
        d.totals.p90t.toFixed(1),
        d.totals.maxt.toFixed(1),
        // Misc block
        (d.time-d.startTime).toFixed(),
        d.generationTime.toFixed(),
        d.totals.packets,
    ];
    logStream.write(values.join(",") + "\n");
}




