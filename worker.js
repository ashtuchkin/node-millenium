var config = JSON.parse(process.env.WORKER_CONFIG || "{}");

// Workers can share any TCP connection
// In this case its a HTTP server
var server = require('http').createServer();

if (config.setNoDelay)
    server.on('connection', function(socket) {
        socket.setNoDelay(); // Disable Nagle's alg.
    });

var connections = 0;
var packets = 0;
server.on('request', function(req, res) {
    connections++;
    var pingInterval = setInterval(function() {
        res.write('ping');
        packets++;
    }, config.pingInterval);

    res.writeHead(200);
    res.write("Welcome!");

    res.on('close', function() {
        connections--;
        clearInterval(pingInterval);
        pingInterval = undefined;
    });
    // TODO: res.on('error') ?
});

server.listen(config.port);


// Gather statistics.
function hrtime() { var hr = process.hrtime(); return hr[0]*1e3 + hr[1]*1e-6; }

var lastTimes = {};
function timeFromLast(name) { 
    var curt = hrtime();
    var res = 0;
    if (lastTimes[name])
        res = curt - lastTimes[name];
    lastTimes[name] = curt;
    return res;
}

// Make high-frequency sampling of event loop.
var ticks = [];
setInterval(function() {
    ticks.push(timeFromLast('tick'));
}, config.samplingInterval);

// Respond on data request.
process.on('message', function(param) {
    process.send({
        id: param.id, // Identify this is an answer to particular request.
        timeFromLast: timeFromLast('message'),
        ticks: ticks,
        mem: process.memoryUsage(),
        conns: connections,
        packets: packets,
    });
    
    ticks.length = 0;
});

// ==== GC =====================================================================
if (typeof gc === 'function')
    setInterval(gc, config.gcInterval);
