const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
});
const Launcher = require('./Launcher');
(async function() {
    try {
        const close = await Launcher.launch({
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
        });
        const good = await isGood();
        try {
            await close();
        } catch(e) {
            // failing to close is fine, we might have already closed
        }
        process.exit(good ? 0 : 1);
    } catch (e) {
        console.error('Error launching Chrome!');
        console.error(e.code);
        process.exit(1);
    }
    
    async function isGood() {
        const goodAnswers = new Set(['g', 'good', 'y', 'yes']);
        const badAnswers = new Set(['b', 'bad', 'n',' no']);

        while (true) {
            const answer = await ask();
            if (goodAnswers.has(answer))
                return true;
            if (badAnswers.has(answer))
                return false;
            console.log(`Unknown response '${answer}'. Please enter g or b.`);
        }
    }
    async function ask() {
        const answer = await new Promise(x => {
            readline.question('Good or bad? [g/b]: ', x);
        });
        return answer.toLowerCase();
    }
})();
