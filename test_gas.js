const url = "https://script.google.com/macros/s/AKfycbzADK6UFMk6lHsc2uOFpcYmz4zLqbWeMxiBJ839WUNRaRwZFCBw0VMEhMLZAyMtnsw/exec";

async function test() {
    const payload = {
        action: "publishReport",
        week: 9,
        reports: [{
            companyName: "파워넷",
            stats: {},
            summary: "test summary",
            plan: "test plan"
        }]
    };

    try {
        const res = await fetch(url, {
            method: "POST",
            body: JSON.stringify(payload),
            headers: {
                "Content-Type": "text/plain"
            }
        });

        const text = await res.text();
        console.log("Response:", text);
    } catch (error) {
        console.error("Error:", error);
    }
}
test();
